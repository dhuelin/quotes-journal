import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { GroupStore } from './group-store';
import { UserStore } from './user-store';
import { RateLimiter, type RateLimitDecision } from './rate-limiter';
import { appHtml } from './ui';
import { LIMITS } from './domain';
import {
  createInviteCode,
  createSessionToken,
  hashPassword,
  readInviteCode,
  verifySessionToken,
  type SessionUser,
} from './auth';
import { readJsonBody, validateEmail, validatePassword, validateRevealYear, validateText } from './validation';

export { GroupStore, UserStore, RateLimiter };

export type Env = {
  GROUPS: DurableObjectNamespace;
  USERS: DurableObjectNamespace;
  RATE_LIMIT: DurableObjectNamespace;
  /** Set with `wrangler secret put AUTH_SECRET`; locally via .dev.vars. */
  AUTH_SECRET?: string;
  RATE_LIMIT_AUTH?: string;
  RATE_LIMIT_WRITE?: string;
};

type AppEnv = { Bindings: Env; Variables: { user: SessionUser } };

const app = new Hono<AppEnv>();

const jsonError = (message: string, status: number, extra: Record<string, unknown> = {}): Response =>
  new Response(JSON.stringify({ error: message, ...extra }), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });

const requireSecret = (env: Env): string | null => env.AUTH_SECRET ?? null;

/**
 * Behind Cloudflare, `cf-connecting-ip` is set by the edge and overwrites any
 * value the client sent, so it is safe to key rate limit buckets on.
 */
const clientKey = (request: Request): string => request.headers.get('cf-connecting-ip') ?? 'unknown';

const checkRateLimit = async (
  env: Env,
  bucket: string,
  limit: number,
  windowMs: number,
): Promise<RateLimitDecision> => {
  const stub = env.RATE_LIMIT.get(env.RATE_LIMIT.idFromName(bucket));
  const response = await stub.fetch(`https://limiter/consume?limit=${limit}&windowMs=${windowMs}`);
  return (await response.json()) as RateLimitDecision;
};

const numberFromEnv = (raw: string | undefined, fallback: number): number => {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

const authLimit = (env: Env) => ({ limit: numberFromEnv(env.RATE_LIMIT_AUTH, 10), windowMs: 10 * 60 * 1000 });
const writeLimit = (env: Env) => ({ limit: numberFromEnv(env.RATE_LIMIT_WRITE, 60), windowMs: 60 * 1000 });

const tooManyRequests = (decision: RateLimitDecision): Response =>
  new Response(JSON.stringify({ error: 'Too many requests, please slow down' }), {
    status: 429,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'retry-after': String(decision.retryAfterSeconds),
    },
  });

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

const passThrough = async (response: Response): Promise<Response> =>
  new Response(await response.text(), {
    status: response.status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });

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

const serviceWorkerScript = `self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));`;

const appIcon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" role="img" aria-label="Quotes Journal">
  <rect width="256" height="256" fill="#0f1020"/>
  <text x="50%" y="58%" dominant-baseline="middle" text-anchor="middle" fill="#f8c630" font-size="140" font-family="Georgia, serif">&#8220;&#8221;</text>
</svg>`;

app.get('/', (c) => c.html(appHtml));
app.get('/app', (c) => c.html(appHtml));
app.get('/join', (c) => c.html(appHtml));
app.get('/manifest.webmanifest', (c) => c.json(appManifest));
app.get('/sw.js', (c) =>
  c.body(serviceWorkerScript, 200, {
    'content-type': 'application/javascript; charset=utf-8',
    'cache-control': 'no-cache',
  }),
);
app.get('/icon.svg', (c) => c.body(appIcon, 200, { 'content-type': 'image/svg+xml; charset=utf-8' }));

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

  c.set('user', user);
  await next();
  return undefined;
};

app.use('/api/groups', requireUser);
app.use('/api/groups/*', requireUser);
app.use('/api/invites/*', requireUser);
app.use('/api/auth/me', requireUser);

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

  const passwordHash = await hashPassword(password.value);
  const response = await callUserStore(c.env, email.value, '/register', {
    id: crypto.randomUUID(),
    email: email.value,
    displayName: displayName.value,
    passwordHash,
  });

  if (!response.ok) {
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

  const response = await callUserStore(c.env, email.value, '/login', { password: body.value.password });
  if (!response.ok) {
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

  const groupId = crypto.randomUUID();
  const response = await callGroupStore(c.env, groupId, '/init', user, 'POST', {
    id: groupId,
    name: name.value,
    revealYear: revealYear.value,
  });

  if (!response.ok) {
    return passThrough(response);
  }

  await callUserStore(c.env, user.email, '/groups', {
    groupId,
    name: name.value,
    revealYear: revealYear.value,
    role: 'owner',
  });

  return passThrough(response);
});

app.get('/api/groups/:groupId', async (c) =>
  passThrough(await callGroupStore(c.env, c.req.param('groupId'), '/group', c.get('user'))),
);

app.get('/api/groups/:groupId/quotes', async (c) =>
  passThrough(await callGroupStore(c.env, c.req.param('groupId'), '/quotes', c.get('user'))),
);

app.get('/api/groups/:groupId/quiz', async (c) =>
  passThrough(await callGroupStore(c.env, c.req.param('groupId'), '/quiz', c.get('user'))),
);

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
app.post('/api/groups/:groupId/quotes', (c) => forwardWrite(c, '/quotes'));

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
  const inviteCode = await createInviteCode(secret, groupId, overview.group.inviteVersion);
  return c.json({ inviteCode, inviteUrl: new URL(`/join?invite=${inviteCode}`, c.req.url).toString() });
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
  return c.json({ inviteCode, inviteUrl: new URL(`/join?invite=${inviteCode}`, c.req.url).toString() });
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
  const invite = inviteCode ? await readInviteCode(secret, inviteCode) : null;
  if (!invite) {
    return jsonError('This invite link is not valid', 400);
  }

  const response = await callGroupStore(c.env, invite.groupId, '/join', user, 'POST', {
    inviteVersion: invite.version,
  });

  if (!response.ok) {
    return passThrough(response);
  }

  const joined = (await response.json()) as { group: { id: string; name: string; revealYear: number } };
  await callUserStore(c.env, user.email, '/groups', {
    groupId: joined.group.id,
    name: joined.group.name,
    revealYear: joined.group.revealYear,
    role: 'member',
  });

  // 201 the first time, 200 when the caller was already a member.
  return c.json(joined, response.status === 201 ? 201 : 200);
});

app.notFound(() => jsonError('Not found', 404));

export default app;
