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
 * PBKDF2 rounds. Kept deliberately modest: one derivation costs roughly 5ms of
 * CPU, and Cloudflare's free plan allows 10ms per request. Raise it (100k costs
 * about 15ms) once the Worker runs on a paid plan. Stored hashes record the
 * count they were made with, so existing accounts keep working after a change.
 */
export const PBKDF2_ITERATIONS = 30_000;

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

export const hashPassword = async (password: string, saltInput?: Uint8Array<ArrayBuffer>): Promise<string> => {
  const salt: Uint8Array<ArrayBuffer> = saltInput ?? crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    key,
    256,
  );

  return `pbkdf2$${PBKDF2_ITERATIONS}$${toBase64Url(salt)}$${toBase64Url(bits)}`;
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
 * The version lets an owner rotate a leaked link without recreating the group.
 */
export const createInviteCode = async (secret: string, groupId: string, version: number): Promise<string> => {
  const body = `${groupId}.${version}`;
  const signature = await hmac(secret, `invite:${body}`);
  return `${toBase64Url(encoder.encode(body))}.${signature}`;
};

export const readInviteCode = async (
  secret: string,
  code: string,
): Promise<{ groupId: string; version: number } | null> => {
  const [body, signature] = code.split('.');
  if (!body || !signature) {
    return null;
  }

  let decoded: string;
  try {
    decoded = new TextDecoder().decode(fromBase64Url(body));
  } catch {
    return null;
  }

  const expected = await hmac(secret, `invite:${decoded}`);
  if (!timingSafeEqual(expected, signature)) {
    return null;
  }

  const separator = decoded.lastIndexOf('.');
  if (separator <= 0) {
    return null;
  }

  const groupId = decoded.slice(0, separator);
  const version = Number(decoded.slice(separator + 1));
  if (!groupId || !Number.isInteger(version) || version < 1) {
    return null;
  }

  return { groupId, version };
};
