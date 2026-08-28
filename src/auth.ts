/**
 * Password hashing, session tokens and invite codes.
 *
 * Everything here runs on WebCrypto so it works unchanged in workerd and in the
 * vitest workers pool. Tokens are stateless HMACs: there is no session table to
 * keep in sync, at the cost of not being able to revoke a single token before it
 * expires. Rotating AUTH_SECRET invalidates every token at once.
 */

const encoder = new TextEncoder();

/**
 * PBKDF2 rounds when `PBKDF2_ITERATIONS` is not set. OWASP asks for 600,000,
 * which costs about 90ms of CPU and therefore cannot run on Cloudflare's free
 * plan (10ms per request); 30,000 costs roughly 5ms and fits. A paid plan
 * should set `PBKDF2_ITERATIONS = "600000"`.
 */
export const DEFAULT_PBKDF2_ITERATIONS = 30_000;

/** Below this a misconfigured value would silently weaken every new hash. */
const MIN_PBKDF2_ITERATIONS = 10_000;

/** Reads the configured round count, falling back to the default when unusable. */
/**
 * Bounded at both ends. The floor stops a typo weakening every hash; the ceiling
 * stops one taking every login past the Worker CPU limit, which would be a
 * silent authentication outage with nothing pointing at the cause. Only plain
 * decimal digits are accepted, so `1e9` and `0x100000` fall back rather than
 * resolving to a billion rounds.
 */
export const resolvePbkdf2Iterations = (raw: unknown): number => {
  if (typeof raw !== 'string' && typeof raw !== 'number') {
    return DEFAULT_PBKDF2_ITERATIONS;
  }

  const text = String(raw).trim();
  if (!/^\d+$/.test(text)) {
    return DEFAULT_PBKDF2_ITERATIONS;
  }

  const value = Number(text);
  if (!Number.isInteger(value) || value < MIN_PBKDF2_ITERATIONS || value > MAX_PBKDF2_ITERATIONS) {
    return DEFAULT_PBKDF2_ITERATIONS;
  }

  return value;
};

export const MAX_PBKDF2_ITERATIONS = 1_000_000;

export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;

export type SessionUser = {
  id: string;
  email: string;
  displayName: string;
};

const toBase64Url = (bytes: ArrayBuffer | Uint8Array): string => {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  for (const byte of view) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
};

const fromBase64Url = (value: string): Uint8Array<ArrayBuffer> => {
  const padded = value.replaceAll('-', '+').replaceAll('_', '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
};

const timingSafeEqual = (left: string, right: string): boolean => {
  if (left.length !== right.length) {
    return false;
  }

  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) {
    mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return mismatch === 0;
};

const hmac = async (secret: string, message: string): Promise<string> => {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
  return toBase64Url(signature);
};

export const hashPassword = async (
  password: string,
  iterations: number = DEFAULT_PBKDF2_ITERATIONS,
  saltInput?: Uint8Array<ArrayBuffer>,
): Promise<string> => {
  const salt: Uint8Array<ArrayBuffer> = saltInput ?? crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, key, 256);

  return `pbkdf2$${iterations}$${toBase64Url(salt)}$${toBase64Url(bits)}`;
};

/**
 * The round count a stored hash was made with. Lets a login notice that an
 * account predates a raised `PBKDF2_ITERATIONS` and re-hash it in place.
 */
export const readHashIterations = (stored: string): number | null => {
  const [scheme, iterationsRaw] = stored.split('$');
  const iterations = Number(iterationsRaw);
  return scheme === 'pbkdf2' && Number.isInteger(iterations) && iterations > 0 ? iterations : null;
};

export const verifyPassword = async (password: string, stored: string): Promise<boolean> => {
  const [scheme, iterationsRaw, saltRaw, digestRaw] = stored.split('$');
  if (scheme !== 'pbkdf2' || !iterationsRaw || !saltRaw || !digestRaw) {
    return false;
  }

  const iterations = Number(iterationsRaw);
  if (!Number.isInteger(iterations) || iterations <= 0) {
    return false;
  }

  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: fromBase64Url(saltRaw), iterations, hash: 'SHA-256' },
    key,
    256,
  );

  return timingSafeEqual(toBase64Url(bits), digestRaw);
};

type TokenPayload = SessionUser & { exp: number };

export const createSessionToken = async (
  secret: string,
  user: SessionUser,
  now: Date = new Date(),
): Promise<string> => {
  const payload: TokenPayload = {
    ...user,
    exp: Math.floor(now.getTime() / 1000) + SESSION_TTL_SECONDS,
  };

  const body = toBase64Url(encoder.encode(JSON.stringify(payload)));
  const signature = await hmac(secret, body);
  return `${body}.${signature}`;
};

export const verifySessionToken = async (
  secret: string,
  token: string,
  now: Date = new Date(),
): Promise<SessionUser | null> => {
  const [body, signature] = token.split('.');
  if (!body || !signature) {
    return null;
  }

  const expected = await hmac(secret, body);
  if (!timingSafeEqual(expected, signature)) {
    return null;
  }

  let payload: TokenPayload;
  try {
    payload = JSON.parse(new TextDecoder().decode(fromBase64Url(body))) as TokenPayload;
  } catch {
    return null;
  }

  if (typeof payload.exp !== 'number' || payload.exp * 1000 <= now.getTime()) {
    return null;
  }

  if (typeof payload.id !== 'string' || typeof payload.email !== 'string' || typeof payload.displayName !== 'string') {
    return null;
  }

  return { id: payload.id, email: payload.email, displayName: payload.displayName };
};

/**
 * Invite codes carry the group they belong to, so joining needs no lookup table.
 * The version lets an owner rotate a leaked link without recreating the group,
 * and the expiry bounds the damage of a link that leaks out of a chat thread.
 */
export const INVITE_TTL_SECONDS = 7 * 24 * 60 * 60;

export type InviteRead =
  | { ok: true; groupId: string; version: number }
  | { ok: false; reason: 'invalid' | 'expired' };

const invalidInvite: InviteRead = { ok: false, reason: 'invalid' };

export const createInviteCode = async (
  secret: string,
  groupId: string,
  version: number,
  now: Date = new Date(),
): Promise<string> => {
  const expiresAt = Math.floor(now.getTime() / 1000) + INVITE_TTL_SECONDS;
  const body = `${groupId}.${version}.${expiresAt}`;
  const signature = await hmac(secret, `invite:${body}`);
  return `${toBase64Url(encoder.encode(body))}.${signature}`;
};

export const readInviteCode = async (secret: string, code: string, now: Date = new Date()): Promise<InviteRead> => {
  const [body, signature] = code.split('.');
  if (!body || !signature) {
    return invalidInvite;
  }

  let decoded: string;
  try {
    decoded = new TextDecoder().decode(fromBase64Url(body));
  } catch {
    return invalidInvite;
  }

  const expected = await hmac(secret, `invite:${decoded}`);
  if (!timingSafeEqual(expected, signature)) {
    return invalidInvite;
  }

  // Group ids may contain dots, so the two trailing fields are peeled off the
  // right rather than splitting the payload.
  const expirySeparator = decoded.lastIndexOf('.');
  const versionSeparator = decoded.lastIndexOf('.', expirySeparator - 1);
  if (versionSeparator <= 0) {
    return invalidInvite;
  }

  const groupId = decoded.slice(0, versionSeparator);
  const version = Number(decoded.slice(versionSeparator + 1, expirySeparator));
  const expiresAt = Number(decoded.slice(expirySeparator + 1));
  if (!groupId || !Number.isInteger(version) || version < 1 || !Number.isInteger(expiresAt)) {
    return invalidInvite;
  }

  if (expiresAt * 1000 <= now.getTime()) {
    return { ok: false, reason: 'expired' };
  }

  return { ok: true, groupId, version };
};
