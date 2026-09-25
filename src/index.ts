import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { GroupStore } from './group-store';
import { UserStore } from './user-store';
import { RateLimiter, type RateLimitDecision } from './rate-limiter';
import { renderAppHtml, renderPrivacyHtml } from './ui';
import { policies } from './csp';
import { LIMITS } from './domain';
import {
  createInviteCode,
  createSessionToken,
  hashPassword,
  readInviteCode,
  resolvePbkdf2Iterations,
  verifySessionToken,
  type SessionUser,
} from './auth';
import {
  readJsonBody,
  validateEmail,
  validatePassword,
  validateRevealAt,
  validateRevealYear,
  validateText,
} from './validation';
import { readImageUpload } from './images';

export { GroupStore, UserStore, RateLimiter };

export type Env = {
  GROUPS: DurableObjectNamespace;
  USERS: DurableObjectNamespace;
  RATE_LIMIT: DurableObjectNamespace;
  /** Set with `wrangler secret put AUTH_SECRET`; locally via .dev.vars. */
  AUTH_SECRET?: string;
  RATE_LIMIT_AUTH?: string;
  RATE_LIMIT_AUTH_ACCOUNT?: string;
  RATE_LIMIT_AUTH_ACCOUNT_WIDE?: string;
  RATE_LIMIT_WRITE?: string;
  RATE_LIMIT_READ?: string;
  /** PBKDF2 rounds; see `DEFAULT_PBKDF2_ITERATIONS` for the free-plan trade-off. */
  PBKDF2_ITERATIONS?: string;
};

type AppEnv = { Bindings: Env; Variables: { user: SessionUser } };

const app = new Hono<AppEnv>();

/** Applied to every response: a sniffed content type is a bug waiting to happen. */
const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'x-content-type-options': 'nosniff',
} as const;

const jsonError = (message: string, status: number, extra: Record<string, unknown> = {}): Response =>
  new Response(JSON.stringify({ error: message, ...extra }), { status, headers: JSON_HEADERS });

const requireSecret = (env: Env): string | null => env.AUTH_SECRET ?? null;

/**
 * Behind the Cloudflare edge `cf-connecting-ip` is overwritten by the edge, but
 * the Dockerfile also ships `wrangler dev` as a supported way to run this, and
 * there the header is whatever the client sends. So this is a useful bucket key,
 * not a trustworthy one: auth routes pair it with `accountKey` below, which no
 * header can rotate.
 */
const clientKey = (request: Request): string => request.headers.get('cf-connecting-ip') ?? 'unknown';

/**
 * Header-independent bucket keys for the auth routes.
 *
 * Split three ways deliberately. `purpose` keeps a register probe from spending
 * login's budget, so nobody can deny an account by poking at its address. The
 * narrow bucket is keyed on the address *and* the client, so one attacker
 * exhausts only their own; the wide one is a slower per-address backstop that
 * still throttles an attacker spread across many addresses' worth of IPs.
 */
const narrowAccountKey = (purpose: string, email: string, request: Request): string =>
  `auth:${purpose}:${email}:${clientKey(request)}`;

const wideAccountKey = (purpose: string, email: string): string => `auth:${purpose}:all:${email}`;

const checkRateLimit = async (
  env: Env,
  bucket: string,
  limit: number,
  windowMs: number,
  consume = true,
): Promise<RateLimitDecision> => {
  const stub = env.RATE_LIMIT.get(env.RATE_LIMIT.idFromName(bucket));
  const response = await stub.fetch(
    `https://limiter/consume?limit=${limit}&windowMs=${windowMs}${consume ? '' : '&consume=0'}`,
  );
  return (await response.json()) as RateLimitDecision;
};

const numberFromEnv = (raw: string | undefined, fallback: number): number => {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

const authLimit = (env: Env) => ({ limit: numberFromEnv(env.RATE_LIMIT_AUTH, 10), windowMs: 10 * 60 * 1000 });
const accountAuthLimit = (env: Env) => ({
  limit: numberFromEnv(env.RATE_LIMIT_AUTH_ACCOUNT, 5),
  windowMs: 15 * 60 * 1000,
});
/** The per-address backstop: higher and slower, so it bites only a distributed run. */
const wideAccountLimit = (env: Env) => ({
  limit: numberFromEnv(env.RATE_LIMIT_AUTH_ACCOUNT_WIDE, 20),
  windowMs: 60 * 60 * 1000,
});
const writeLimit = (env: Env) => ({ limit: numberFromEnv(env.RATE_LIMIT_WRITE, 60), windowMs: 60 * 1000 });
const readLimit = (env: Env) => ({ limit: numberFromEnv(env.RATE_LIMIT_READ, 120), windowMs: 60 * 1000 });

/**
 * Looks at both per-address buckets without spending from either. Blocked looks
 * exactly like a blocked IP.
 */
const peekAccountLimit = async (env: Env, purpose: string, email: string, request: Request) => {
  const narrow = accountAuthLimit(env);
  const wide = wideAccountLimit(env);

  const [narrowDecision, wideDecision] = await Promise.all([
    checkRateLimit(env, narrowAccountKey(purpose, email, request), narrow.limit, narrow.windowMs, false),
    checkRateLimit(env, wideAccountKey(purpose, email), wide.limit, wide.windowMs, false),
  ]);

  return narrowDecision.allowed ? wideDecision : narrowDecision;
};

/** Spends from both per-address buckets. Only ever called after a failed attempt. */
const spendAccountLimit = async (env: Env, purpose: string, email: string, request: Request): Promise<void> => {
  const narrow = accountAuthLimit(env);
  const wide = wideAccountLimit(env);

  await Promise.all([
    checkRateLimit(env, narrowAccountKey(purpose, email, request), narrow.limit, narrow.windowMs),
    checkRateLimit(env, wideAccountKey(purpose, email), wide.limit, wide.windowMs),
  ]);
};

const tooManyRequests = (decision: RateLimitDecision): Response =>
  new Response(
    // The client turns retryAfterSeconds into "try again in N minutes"; a bare
    // "slow down" leaves a locked-out user with no idea how long to wait.
    JSON.stringify({
      error: 'Too many attempts, please wait before trying again',
      retryAfterSeconds: decision.retryAfterSeconds,
    }),
    { status: 429, headers: { ...JSON_HEADERS, 'retry-after': String(decision.retryAfterSeconds) } },
  );

const callUserStore = (env: Env, email: string, path: string, body?: unknown): Promise<Response> => {
  const stub = env.USERS.get(env.USERS.idFromName(email));
  return stub.fetch(
    new Request(`https://user${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
};

const callGroupStore = (
  env: Env,
  groupId: string,
  path: string,
  user: SessionUser,
  method: 'GET' | 'POST' = 'GET',
  body?: unknown,
): Promise<Response> => {
  const stub = env.GROUPS.get(env.GROUPS.idFromName(groupId));
  return stub.fetch(
    new Request(`https://group${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        'x-user-id': user.id,
        'x-user-name': user.displayName,
      },
      body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
    }),
  );
};

/**
 * The same call for a body that is not JSON. Quote pictures are sent as raw
 * bytes: base64 in a JSON envelope would inflate them by a third and would not
 * fit the 16KB body cap that every other route relies on.
 */
const callGroupStoreRaw = (
  env: Env,
  groupId: string,
  path: string,
  user: SessionUser,
  method: 'GET' | 'POST',
  body?: BodyInit,
  extraHeaders: Record<string, string> = {},
): Promise<Response> => {
  const stub = env.GROUPS.get(env.GROUPS.idFromName(groupId));
  return stub.fetch(
    new Request(`https://group${path}`, {
      method,
      headers: {
        ...extraHeaders,
        'x-user-id': user.id,
        'x-user-name': user.displayName,
      },
      body,
    }),
  );
};

/**
 * A group is recorded twice — in the group object and on the account — and only
 * the account side carries the cap. Checking it before the group object is
 * written keeps an over-cap creation from leaving a group nobody can reach.
 * `groupId` exempts a group the account already lists, so re-accepting an invite
 * stays idempotent at the cap.
 */
const accountHasGroupCapacity = async (env: Env, user: SessionUser, groupId?: string): Promise<boolean> => {
  const response = await callUserStore(env, user.email, '/account');
  if (!response.ok) {
    return false;
  }

  const account = (await response.json()) as { groups: { groupId: string }[] };
  return account.groups.length < LIMITS.groupsPerUser || account.groups.some((ref) => ref.groupId === groupId);
};

const passThrough = async (response: Response): Promise<Response> =>
  new Response(await response.text(), { status: response.status, headers: JSON_HEADERS });

const appManifest = {
  name: 'Quotes Journal',
  short_name: 'Quotes',
  start_url: '/app',
  display: 'standalone',
  background_color: '#0f1020',
  theme_color: '#0f1020',
  icons: [
    {
      src: '/icon.svg',
      type: 'image/svg+xml',
      sizes: 'any',
      purpose: 'any maskable',
    },
  ],
};

/**
 * The service worker, which until now registered and did nothing at all: it had
 * no fetch handler, so an installed app was a shortcut that failed exactly like
 * the browser would.
 *
 * `version` is a fingerprint of the client. It names the cache, so a deploy that
 * changes the client changes this text — and a byte-different service worker is
 * the only thing that makes a browser install a new one and drop the old cache.
 * A version baked in by hand is the usual way an offline app gets stuck showing
 * a build from months ago.
 *
 * What is deliberately never cached: anything under /api. Quotes, pictures and
 * the account itself are read with a bearer token, and a copy in Cache Storage
 * would outlive signing out — readable by whoever picks up the device next, and
 * for a group still under its reveal lock, readable early. The saving would be
 * a round trip; the cost would be the one guarantee this app makes.
 */
const serviceWorker = (version: string): string => `const CACHE = 'quotes-journal-${version}';
const SHELL = '/app';
const PRECACHE = [SHELL, '/icon.svg', '/manifest.webmanifest'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

/** Refreshes the cached copy in the background; failure is simply offline. */
const revalidate = (request, key) =>
  fetch(request)
    .then((response) => {
      if (response && response.ok) {
        caches.open(CACHE).then((cache) => cache.put(key, response.clone()));
      }
      return response;
    })
    .catch(() => null);

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);

  if (request.method !== 'GET' || url.origin !== self.location.origin) {
    return;
  }

  // Never cached, and never served from a cache: see above.
  if (url.pathname.startsWith('/api/')) {
    return;
  }

  // Every in-app path is served the same shell, so one cached copy answers all
  // of them — including a deep link to a group opened with no connection.
  if (request.mode === 'navigate') {
    event.respondWith(
      caches.match(SHELL).then((cached) => {
        const fresh = revalidate(new Request(SHELL), SHELL);
        return cached || fresh.then((response) => response || Response.error());
      }),
    );
    return;
  }

  if (PRECACHE.indexOf(url.pathname) !== -1) {
    event.respondWith(
      caches.match(url.pathname).then((cached) => {
        const fresh = revalidate(request, url.pathname);
        return cached || fresh.then((response) => response || Response.error());
      }),
    );
  }
});`;

const appIcon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" role="img" aria-label="Quotes Journal">
  <rect width="256" height="256" fill="#0f1020"/>
  <text x="50%" y="58%" dominant-baseline="middle" text-anchor="middle" fill="#f8c630" font-size="140" font-family="Georgia, serif">&#8220;&#8221;</text>
</svg>`;

/**
 * The app shell, served with a policy that names its inline style and script by
 * content hash. Identical on every response, which is what lets the service
 * worker keep a copy and open the app with no connection.
 */
const htmlResponse = async (
  body: string,
  policy: string,
  extra: Record<string, string> = {},
): Promise<Response> =>
  new Response(body, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': policy,
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'x-frame-options': 'DENY',
      'strict-transport-security': 'max-age=31536000; includeSubDomains',
      // Revalidated rather than held: the service worker is what serves this
      // instantly, and it refreshes its copy in the background.
      'cache-control': 'no-cache',
      ...extra,
    },
  });

const appShell = async (): Promise<Response> => htmlResponse(renderAppHtml(), (await policies()).app);

app.get('/', () => appShell());
app.get('/app', () => appShell());
app.get('/join', () => appShell());
// Both app stores require a reachable privacy policy URL in the listing.
app.get('/privacy', async () => htmlResponse(renderPrivacyHtml(), (await policies()).privacy));
app.get('/manifest.webmanifest', (c) =>
  c.body(JSON.stringify(appManifest), 200, {
    'content-type': 'application/manifest+json; charset=utf-8',
    'x-content-type-options': 'nosniff',
  }),
);
app.get('/sw.js', async (c) =>
  c.body(serviceWorker((await policies()).version), 200, {
    'content-type': 'application/javascript; charset=utf-8',
    'cache-control': 'no-cache',
    'x-content-type-options': 'nosniff',
  }),
);
app.get('/icon.svg', (c) =>
  c.body(appIcon, 200, {
    'content-type': 'image/svg+xml; charset=utf-8',
    'x-content-type-options': 'nosniff',
  }),
);

/** Rejects requests without a valid session token. */
const requireUser: MiddlewareHandler<AppEnv> = async (c, next) => {
  const secret = requireSecret(c.env);
  if (!secret) {
    return jsonError('Authentication is not configured on this deployment', 503);
  }

  const header = c.req.header('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
  if (!token) {
    return jsonError('Sign in to continue', 401);
  }

  const user = await verifySessionToken(secret, token);
  if (!user) {
    return jsonError('Your session has expired, please sign in again', 401);
  }

  // Authenticated reads had no ceiling at all, and /quiz and /stats rebuild over
  // the whole quote array on every call. Every authenticated route passes
  // through here, so this bucket also backstops the write routes.
  const { limit, windowMs } = readLimit(c.env);
  const decision = await checkRateLimit(c.env, `read:${user.id}`, limit, windowMs);
  if (!decision.allowed) {
    return tooManyRequests(decision);
  }

  c.set('user', user);
  await next();
  return undefined;
};

app.use('/api/groups', requireUser);
app.use('/api/groups/*', requireUser);
app.use('/api/invites/*', requireUser);
app.use('/api/auth/me', requireUser);
app.use('/api/account/*', requireUser);

app.post('/api/auth/register', async (c) => {
  const secret = requireSecret(c.env);
  if (!secret) {
    return jsonError('Authentication is not configured on this deployment', 503);
  }

  const { limit, windowMs } = authLimit(c.env);
  const decision = await checkRateLimit(c.env, `auth:${clientKey(c.req.raw)}`, limit, windowMs);
  if (!decision.allowed) {
    return tooManyRequests(decision);
  }

  const body = await readJsonBody(c.req.raw);
  if (!body.ok) {
    return jsonError(body.error, 400);
  }

  const email = validateEmail(body.value.email);
  if (!email.ok) {
    return jsonError(email.error, 400);
  }

  const displayName = validateText(body.value.displayName, 'Display name', LIMITS.displayName, { minLength: 2 });
  if (!displayName.ok) {
    return jsonError(displayName.error, 400);
  }

  const password = validatePassword(body.value.password);
  if (!password.ok) {
    return jsonError(password.error, 400);
  }

  const accountDecision = await peekAccountLimit(c.env, 'register', email.value, c.req.raw);
  if (!accountDecision.allowed) {
    return tooManyRequests(accountDecision);
  }

  const passwordHash = await hashPassword(password.value, resolvePbkdf2Iterations(c.env.PBKDF2_ITERATIONS));
  const response = await callUserStore(c.env, email.value, '/register', {
    id: crypto.randomUUID(),
    email: email.value,
    displayName: displayName.value,
    passwordHash,
  });

  // A taken address still answers 409: with no email provider wired up, a
  // neutral "check your inbox" would leave the user unable to finish signing up.
  //
  // That 409 remains an enumeration oracle. The per-address buckets do not close
  // it — enumeration probes each address once, so every address arrives with a
  // full bucket — and only the per-IP limit slows it down. The real fix is a
  // neutral response with the outcome delivered by email; it waits on issue #6.
  if (!response.ok) {
    await spendAccountLimit(c.env, 'register', email.value, c.req.raw);
    return passThrough(response);
  }

  const created = (await response.json()) as { user: SessionUser };
  const token = await createSessionToken(secret, created.user);
  return c.json({ token, user: created.user }, 201);
});

app.post('/api/auth/login', async (c) => {
  const secret = requireSecret(c.env);
  if (!secret) {
    return jsonError('Authentication is not configured on this deployment', 503);
  }

  const { limit, windowMs } = authLimit(c.env);
  const decision = await checkRateLimit(c.env, `auth:${clientKey(c.req.raw)}`, limit, windowMs);
  if (!decision.allowed) {
    return tooManyRequests(decision);
  }

  const body = await readJsonBody(c.req.raw);
  if (!body.ok) {
    return jsonError(body.error, 400);
  }

  const email = validateEmail(body.value.email);
  if (!email.ok) {
    return jsonError('Email or password is incorrect', 401);
  }

  const accountDecision = await peekAccountLimit(c.env, 'login', email.value, c.req.raw);
  if (!accountDecision.allowed) {
    return tooManyRequests(accountDecision);
  }

  const response = await callUserStore(c.env, email.value, '/login', {
    password: body.value.password,
    // Passed down so the account object can re-hash an outdated password on a
    // successful sign-in; the Worker owns the configuration.
    iterations: resolvePbkdf2Iterations(c.env.PBKDF2_ITERATIONS),
  });
  // Only a failed attempt costs the account budget, so signing in correctly on
  // several devices never locks the owner out of their own account.
  if (!response.ok) {
    await spendAccountLimit(c.env, 'login', email.value, c.req.raw);
    return jsonError('Email or password is incorrect', 401);
  }

  const authenticated = (await response.json()) as { user: SessionUser };
  const token = await createSessionToken(secret, authenticated.user);
  return c.json({ token, user: authenticated.user });
});

app.get('/api/auth/me', async (c) => {
  const user = c.get('user');
  const response = await callUserStore(c.env, user.email, '/account');
  if (!response.ok) {
    return jsonError('Account not found', 404);
  }

  return passThrough(response);
});

app.get('/api/groups', async (c) => {
  const user = c.get('user');
  const response = await callUserStore(c.env, user.email, '/account');
  if (!response.ok) {
    return c.json({ groups: [] });
  }

  const account = (await response.json()) as { groups: unknown[] };
  return c.json({ groups: account.groups });
});

app.post('/api/groups', async (c) => {
  const user = c.get('user');
  const { limit, windowMs } = writeLimit(c.env);
  const decision = await checkRateLimit(c.env, `write:${user.id}`, limit, windowMs);
  if (!decision.allowed) {
    return tooManyRequests(decision);
  }

  const body = await readJsonBody(c.req.raw);
  if (!body.ok) {
    return jsonError(body.error, 400);
  }

  const name = validateText(body.value.name, 'Group name', LIMITS.groupName);
  if (!name.ok) {
    return jsonError(name.error, 400);
  }

  const revealYear = validateRevealYear(body.value.revealYear);
  if (!revealYear.ok) {
    return jsonError(revealYear.error, 400);
  }

  // Optional: without it the group opens at midnight UTC on 1 January, which is
  // what every group did before the date was configurable.
  let revealAt: string | undefined;
  if (body.value.revealAt !== undefined && body.value.revealAt !== null && body.value.revealAt !== '') {
    const picked = validateRevealAt(body.value.revealAt);
    if (!picked.ok) {
      return jsonError(picked.error, 400);
    }
    revealAt = picked.value;
  }

  if (!(await accountHasGroupCapacity(c.env, user))) {
    return jsonError(`You can belong to at most ${LIMITS.groupsPerUser} groups`, 409);
  }

  const groupId = crypto.randomUUID();
  const response = await callGroupStore(c.env, groupId, '/init', user, 'POST', {
    id: groupId,
    name: name.value,
    revealYear: revealYear.value,
    revealAt,
  });

  if (!response.ok) {
    return passThrough(response);
  }

  const linked = await callUserStore(c.env, user.email, '/groups', {
    groupId,
    name: name.value,
    revealYear: revealYear.value,
    role: 'owner',
  });

  if (!linked.ok) {
    return passThrough(linked);
  }

  return passThrough(response);
});

/**
 * Opening a group is also when its cached name on the account is refreshed —
 * see `/groups/touch` in the account object for why it heals rather than being
 * pushed (#9). The write only happens when the cache is actually stale.
 */
app.get('/api/groups/:groupId', async (c) => {
  const user = c.get('user');
  const response = await callGroupStore(c.env, c.req.param('groupId'), '/group', user);
  if (!response.ok) {
    return passThrough(response);
  }

  const payload = (await response.json()) as { group: { id: string; name: string; revealYear: number } };
  await callUserStore(c.env, user.email, '/groups/touch', {
    groupId: payload.group.id,
    name: payload.group.name,
    revealYear: payload.group.revealYear,
  });

  return c.json(payload);
});

app.get('/api/groups/:groupId/quotes', async (c) =>
  passThrough(await callGroupStore(c.env, c.req.param('groupId'), '/quotes', c.get('user'))),
);

app.get('/api/groups/:groupId/quiz', async (c) =>
  passThrough(await callGroupStore(c.env, c.req.param('groupId'), '/quiz', c.get('user'))),
);

/** Every member's best finished round, which is what makes the quiz a contest. */
app.get('/api/groups/:groupId/quiz/scores', async (c) =>
  passThrough(await callGroupStore(c.env, c.req.param('groupId'), '/quiz/scores', c.get('user'))),
);

/**
 * Postpones the reveal. Owner-only and later-only, both enforced in the group
 * object; this validates the instant before it gets there.
 */
app.post('/api/groups/:groupId/reveal', async (c) => {
  const body = await readJsonBody(c.req.raw);
  if (!body.ok) {
    return jsonError(body.error, 400);
  }

  const picked = validateRevealAt(body.value.revealAt);
  if (!picked.ok) {
    return jsonError(picked.error, 400);
  }

  const user = c.get('user');
  const { limit, windowMs } = writeLimit(c.env);
  const decision = await checkRateLimit(c.env, `write:${user.id}`, limit, windowMs);
  if (!decision.allowed) {
    return tooManyRequests(decision);
  }

  return passThrough(
    await callGroupStore(c.env, c.req.param('groupId'), '/reveal', user, 'POST', { revealAt: picked.value }),
  );
});

app.post('/api/groups/:groupId/members/transfer', (c) => forwardWrite(c, '/members/transfer'));

/** Owner-only. The owner's own cached name is corrected here; others heal on open. */
app.post('/api/groups/:groupId/rename', async (c) => {
  const user = c.get('user');
  const renamed = await forwardWrite(c, '/rename');
  if (!renamed.ok) {
    return renamed;
  }

  const payload = (await renamed.json()) as { group: { id: string; name: string; revealYear: number } };
  await callUserStore(c.env, user.email, '/groups/touch', {
    groupId: payload.group.id,
    name: payload.group.name,
    revealYear: payload.group.revealYear,
  });

  return c.json(payload);
});

/**
 * Leaves a group. The member row stays behind as a tombstone so the quotes they
 * appear in keep working; the account forgets the group so it leaves their list.
 */
app.post('/api/groups/:groupId/leave', async (c) => {
  const user = c.get('user');
  const groupId = c.req.param('groupId');
  const left = await forwardWrite(c, '/leave');
  if (!left.ok) {
    return left;
  }

  await callUserStore(c.env, user.email, '/groups/forget', { groupId });
  return c.json({ left: true });
});

/**
 * Changes the display name. It is the name used for new groups and shown on the
 * account; the name inside a group stays as it is, because a group's names have
 * to be unique within it and a silent bulk rename could collide with someone
 * else's. Renaming inside a group is the owner's existing control.
 */
app.post('/api/account/display-name', async (c) => {
  const user = c.get('user');
  const { limit, windowMs } = writeLimit(c.env);
  const decision = await checkRateLimit(c.env, `write:${user.id}`, limit, windowMs);
  if (!decision.allowed) {
    return tooManyRequests(decision);
  }

  const body = await readJsonBody(c.req.raw);
  if (!body.ok) {
    return jsonError(body.error, 400);
  }

  const displayName = validateText(body.value.displayName, 'Display name', LIMITS.displayName, { minLength: 2 });
  if (!displayName.ok) {
    return jsonError(displayName.error, 400);
  }

  const secret = requireSecret(c.env);
  if (!secret) {
    return jsonError('Authentication is not configured on this deployment', 503);
  }

  const response = await callUserStore(c.env, user.email, '/display-name', { displayName: displayName.value });
  if (!response.ok) {
    return passThrough(response);
  }

  // The session token carries the display name, and it is what names the
  // creator of a group or the joiner of one. Without a fresh token the new name
  // would not reach either until the next sign-in.
  const updated = (await response.json()) as { user: SessionUser };
  const token = await createSessionToken(secret, updated.user);
  return c.json({ token, user: updated.user });
});

app.post('/api/groups/:groupId/quiz/start', (c) => forwardWrite(c, '/quiz/start'));
app.post('/api/groups/:groupId/quiz/answer', (c) => forwardWrite(c, '/quiz/answer'));

app.get('/api/groups/:groupId/stats', async (c) =>
  passThrough(await callGroupStore(c.env, c.req.param('groupId'), '/stats', c.get('user'))),
);

/** POST routes that simply forward a validated body to the group object. */
const forwardWrite = async (c: Context<AppEnv>, path: string): Promise<Response> => {
  const user = c.get('user');
  const groupId = c.req.param('groupId') ?? '';
  const { limit, windowMs } = writeLimit(c.env);
  const decision = await checkRateLimit(c.env, `write:${user.id}`, limit, windowMs);
  if (!decision.allowed) {
    return tooManyRequests(decision);
  }

  const body = await readJsonBody(c.req.raw);
  if (!body.ok) {
    return jsonError(body.error, 400);
  }

  return passThrough(await callGroupStore(c.env, groupId, path, user, 'POST', body.value));
};

app.post('/api/groups/:groupId/members', (c) => forwardWrite(c, '/members'));
// Owner-only member management. Claiming binds a guest row to someone who has
// joined, which is the safe replacement for the display-name auto-claim.
app.post('/api/groups/:groupId/members/claim', (c) => forwardWrite(c, '/members/claim'));
app.post('/api/groups/:groupId/members/rename', (c) => forwardWrite(c, '/members/rename'));
app.post('/api/groups/:groupId/members/remove', (c) => forwardWrite(c, '/members/remove'));
app.post('/api/groups/:groupId/quotes', (c) => forwardWrite(c, '/quotes'));
app.post('/api/groups/:groupId/quotes/:quoteId/image/remove', (c) =>
  forwardWrite(c, `/quotes/${encodeURIComponent(c.req.param('quoteId') ?? '')}/image/remove`),
);

/**
 * Attaches a picture to a quote. The bytes are checked here — size first, then
 * what the file actually is, from its magic number rather than its header — so
 * the group object only ever sees something already established to be a JPEG,
 * PNG or WebP.
 */
app.post('/api/groups/:groupId/quotes/:quoteId/image', async (c) => {
  const user = c.get('user');
  const { limit, windowMs } = writeLimit(c.env);
  const decision = await checkRateLimit(c.env, `write:${user.id}`, limit, windowMs);
  if (!decision.allowed) {
    return tooManyRequests(decision);
  }

  const upload = await readImageUpload(c.req.raw);
  if (!upload.ok) {
    return jsonError(upload.error, upload.status);
  }

  const path = `/quotes/${encodeURIComponent(c.req.param('quoteId'))}/image`;
  return passThrough(
    await callGroupStoreRaw(c.env, c.req.param('groupId'), path, user, 'POST', upload.bytes as BodyInit, {
      'x-image-type': upload.contentType,
    }),
  );
});

/**
 * Serves a picture back, behind the same membership check and the same reveal
 * lock as the quote it belongs to. The client fetches this with its bearer
 * token and renders the result as an object URL, so nothing here needs a
 * credential in the URL — which would leak through history and referrers.
 */
app.get('/api/groups/:groupId/quotes/:quoteId/image', async (c) => {
  const path = `/quotes/${encodeURIComponent(c.req.param('quoteId'))}/image`;
  const response = await callGroupStoreRaw(c.env, c.req.param('groupId'), path, c.get('user'), 'GET');

  // A refusal is JSON — locked, not a member, no picture — and a success is the
  // image itself, carrying headers that must survive intact.
  if (!response.ok) {
    return passThrough(response);
  }

  return new Response(response.body, { status: response.status, headers: response.headers });
});

app.get('/api/groups/:groupId/invite', async (c) => {
  const secret = requireSecret(c.env);
  if (!secret) {
    return jsonError('Authentication is not configured on this deployment', 503);
  }

  const groupId = c.req.param('groupId');
  const response = await callGroupStore(c.env, groupId, '/group', c.get('user'));
  if (!response.ok) {
    return passThrough(response);
  }

  const overview = (await response.json()) as { group: { inviteVersion: number } };
  // Only the code: a link built here would take its host from the client's Host
  // header. The client composes the URL from its own origin instead.
  const inviteCode = await createInviteCode(secret, groupId, overview.group.inviteVersion);
  return c.json({ inviteCode });
});

app.post('/api/groups/:groupId/invite/rotate', async (c) => {
  const secret = requireSecret(c.env);
  if (!secret) {
    return jsonError('Authentication is not configured on this deployment', 503);
  }

  const groupId = c.req.param('groupId');
  const response = await callGroupStore(c.env, groupId, '/invite/rotate', c.get('user'), 'POST');
  if (!response.ok) {
    return passThrough(response);
  }

  const rotated = (await response.json()) as { inviteVersion: number };
  const inviteCode = await createInviteCode(secret, groupId, rotated.inviteVersion);
  return c.json({ inviteCode });
});

app.post('/api/invites/accept', async (c) => {
  const secret = requireSecret(c.env);
  if (!secret) {
    return jsonError('Authentication is not configured on this deployment', 503);
  }

  const user = c.get('user');
  const { limit, windowMs } = writeLimit(c.env);
  const decision = await checkRateLimit(c.env, `write:${user.id}`, limit, windowMs);
  if (!decision.allowed) {
    return tooManyRequests(decision);
  }

  const body = await readJsonBody(c.req.raw);
  if (!body.ok) {
    return jsonError(body.error, 400);
  }

  const inviteCode = typeof body.value.inviteCode === 'string' ? body.value.inviteCode.trim() : '';
  const invite = inviteCode ? await readInviteCode(secret, inviteCode) : ({ ok: false, reason: 'invalid' } as const);
  if (!invite.ok) {
    return invite.reason === 'expired'
      ? jsonError('This invite link has expired, ask for a new one', 410)
      : jsonError('This invite link is not valid', 400);
  }

  if (!(await accountHasGroupCapacity(c.env, user, invite.groupId))) {
    return jsonError(`You can belong to at most ${LIMITS.groupsPerUser} groups`, 409);
  }

  const response = await callGroupStore(c.env, invite.groupId, '/join', user, 'POST', {
    inviteVersion: invite.version,
    // Optional: how the joiner wants to be known in *this* group, used when
    // their account's display name is already taken here.
    memberName: body.value.memberName,
  });

  if (!response.ok) {
    return passThrough(response);
  }

  const joined = (await response.json()) as { group: { id: string; name: string; revealYear: number } };
  const linked = await callUserStore(c.env, user.email, '/groups', {
    groupId: joined.group.id,
    name: joined.group.name,
    revealYear: joined.group.revealYear,
    role: 'member',
  });

  if (!linked.ok) {
    return passThrough(linked);
  }

  // 201 the first time, 200 when the caller was already a member.
  return c.json(joined, response.status === 201 ? 201 : 200);
});

app.notFound((c) => {
  // A person who mistypes a path gets the app, not a raw error object; API
  // paths keep answering JSON so clients can still parse the failure.
  const wantsHtml = (c.req.header('accept') ?? '').includes('text/html');
  if (wantsHtml && !c.req.path.startsWith('/api/')) {
    return appShell();
  }

  return jsonError('Not found', 404);
});

export default app;
