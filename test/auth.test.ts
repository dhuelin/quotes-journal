import { describe, expect, it } from 'vitest';
import {
  createInviteCode,
  createResetToken,
  createSessionToken,
  DEFAULT_PBKDF2_ITERATIONS,
  hashPassword,
  INVITE_TTL_SECONDS,
  readHashIterations,
  readInviteCode,
  readResetToken,
  resolvePbkdf2Iterations,
  RESET_TTL_SECONDS,
  SESSION_TTL_SECONDS,
  verifyPassword,
  verifySessionToken,
} from '../src/auth';

const secret = 'unit-test-secret';

describe('password hashing', () => {
  it('accepts the right password and rejects a wrong one', async () => {
    const stored = await hashPassword('correct horse battery staple');

    expect(stored.startsWith('pbkdf2$')).toBe(true);
    expect(await verifyPassword('correct horse battery staple', stored)).toBe(true);
    expect(await verifyPassword('correct horse battery stapl', stored)).toBe(false);
  });

  it('salts each hash so identical passwords do not collide', async () => {
    const first = await hashPassword('same password here');
    const second = await hashPassword('same password here');

    expect(first).not.toBe(second);
    expect(await verifyPassword('same password here', second)).toBe(true);
  });

  it('rejects malformed stored hashes instead of throwing', async () => {
    expect(await verifyPassword('anything', 'not-a-hash')).toBe(false);
    expect(await verifyPassword('anything', 'pbkdf2$0$abc$def')).toBe(false);
    expect(await verifyPassword('anything', '')).toBe(false);
  });
});

describe('session tokens', () => {
  const user = { id: 'u1', email: 'a@example.com', displayName: 'Alice' };

  it('round-trips the signed user', async () => {
    const token = await createSessionToken(secret, user);
    // Plus the session generation, which a default token is the first of.
    expect(await verifySessionToken(secret, token)).toEqual({ ...user, tokenVersion: 0 });
  });

  it('rejects a token signed with a different secret', async () => {
    const token = await createSessionToken(secret, user);
    expect(await verifySessionToken('other-secret', token)).toBeNull();
  });

  it('rejects a tampered payload', async () => {
    const token = await createSessionToken(secret, user);
    const [, signature] = token.split('.');
    const forged = btoa(JSON.stringify({ ...user, id: 'u2', exp: 4102444800 }))
      .replaceAll('+', '-')
      .replaceAll('/', '_')
      .replaceAll('=', '');

    expect(await verifySessionToken(secret, `${forged}.${signature}`)).toBeNull();
  });

  it('rejects expired tokens', async () => {
    const issued = new Date('2026-01-01T00:00:00.000Z');
    const token = await createSessionToken(secret, user, 0, issued);
    const afterExpiry = new Date(issued.getTime() + (SESSION_TTL_SECONDS + 1) * 1000);

    expect(await verifySessionToken(secret, token, afterExpiry)).toBeNull();
    expect(await verifySessionToken(secret, token, issued)).toEqual({ ...user, tokenVersion: 0 });
  });

  it('rejects structurally invalid tokens', async () => {
    expect(await verifySessionToken(secret, '')).toBeNull();
    expect(await verifySessionToken(secret, 'nodot')).toBeNull();
    expect(await verifySessionToken(secret, 'a.b')).toBeNull();
  });
});

describe('invite codes', () => {
  it('carries the group and version it was issued for', async () => {
    const code = await createInviteCode(secret, 'group-123', 2);
    expect(await readInviteCode(secret, code)).toEqual({ ok: true, groupId: 'group-123', version: 2 });
  });

  it('survives group ids containing dots', async () => {
    const code = await createInviteCode(secret, 'group.with.dots', 1);
    expect(await readInviteCode(secret, code)).toEqual({ ok: true, groupId: 'group.with.dots', version: 1 });
  });

  it('rejects forged or foreign codes', async () => {
    const code = await createInviteCode(secret, 'group-123', 1);

    expect(await readInviteCode('other-secret', code)).toEqual({ ok: false, reason: 'invalid' });
    expect(await readInviteCode(secret, 'garbage')).toEqual({ ok: false, reason: 'invalid' });
    expect(await readInviteCode(secret, `${code}x`)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('expires a code after its lifetime, distinguishably from a forged one', async () => {
    const issued = new Date('2026-06-01T00:00:00.000Z');
    const code = await createInviteCode(secret, 'group-123', 1, issued);

    const justBefore = new Date(issued.getTime() + (INVITE_TTL_SECONDS - 60) * 1000);
    const justAfter = new Date(issued.getTime() + (INVITE_TTL_SECONDS + 60) * 1000);

    expect(await readInviteCode(secret, code, justBefore)).toEqual({ ok: true, groupId: 'group-123', version: 1 });
    expect(await readInviteCode(secret, code, justAfter)).toEqual({ ok: false, reason: 'expired' });
  });

  it('refuses a code whose expiry was edited, because the signature covers it', async () => {
    const code = await createInviteCode(secret, 'group-123', 1, new Date('2020-01-01T00:00:00.000Z'));
    const [body, signature] = code.split('.');
    const decoded = atob(body.replaceAll('-', '+').replaceAll('_', '/').padEnd(Math.ceil(body.length / 4) * 4, '='));
    const stretched = decoded.replace(/\.\d+$/, '.4102444800');
    const forgedBody = btoa(stretched).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');

    expect(await readInviteCode(secret, `${forgedBody}.${signature}`)).toEqual({ ok: false, reason: 'invalid' });
  });
});

describe('PBKDF2 configuration', () => {
  it('takes the round count from the environment and falls back when it is unusable', () => {
    expect(resolvePbkdf2Iterations('600000')).toBe(600_000);
    expect(resolvePbkdf2Iterations(600_000)).toBe(600_000);

    for (const raw of [undefined, '', 'lots', '0', '-1', '500', 1.5]) {
      expect(resolvePbkdf2Iterations(raw), String(raw)).toBe(DEFAULT_PBKDF2_ITERATIONS);
    }
  });

  it('records the count it hashed with, so a raised setting is detectable', async () => {
    const low = await hashPassword('a long enough password', 12_000);
    const high = await hashPassword('a long enough password', 40_000);

    expect(readHashIterations(low)).toBe(12_000);
    expect(readHashIterations(high)).toBe(40_000);
    expect(readHashIterations('not-a-hash')).toBeNull();

    // Both keep verifying: a hash is always replayed at its own round count.
    expect(await verifyPassword('a long enough password', low)).toBe(true);
    expect(await verifyPassword('a long enough password', high)).toBe(true);
  });
});

/**
 * The token version is what lets one account end its own sessions without
 * rotating AUTH_SECRET, which would sign out everybody on the deployment.
 */
describe('session generations', () => {
  const secret = 'a-secret-only-the-worker-knows';
  const user = { id: 'u1', email: 'alice@example.com', displayName: 'Alice' };

  it('carries the generation the token was minted in', async () => {
    const token = await createSessionToken(secret, user, 4);

    expect(await verifySessionToken(secret, token)).toEqual({ ...user, tokenVersion: 4 });
  });

  it('reads a token minted before versions existed as generation zero', async () => {
    // Which is what a never-revoked account is on, so the deploy that
    // introduces this signs nobody out.
    const legacy = await createSessionToken(secret, user, 0);
    const payload = JSON.parse(atob(legacy.split('.')[0].replaceAll('-', '+').replaceAll('_', '/')));
    delete payload.v;

    const body = btoa(JSON.stringify(payload)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const signed = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
    const signature = btoa(String.fromCharCode(...new Uint8Array(signed)))
      .replaceAll('+', '-')
      .replaceAll('/', '_')
      .replaceAll('=', '');

    expect(await verifySessionToken(secret, `${body}.${signature}`)).toEqual({ ...user, tokenVersion: 0 });
  });

  it('cannot have its generation edited without breaking the signature', async () => {
    const token = await createSessionToken(secret, user, 1);
    const [body, signature] = token.split('.');
    const payload = JSON.parse(atob(body.replaceAll('-', '+').replaceAll('_', '/')));
    payload.v = 99;

    const forged = btoa(JSON.stringify(payload)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');

    expect(await verifySessionToken(secret, `${forged}.${signature}`)).toBeNull();
  });
});

/**
 * A reset link is a live credential for the whole account, so it is bound
 * tighter than an invite: an hour, one account, and one use.
 */
describe('password reset links', () => {
  const secret = 'a-secret-only-the-worker-knows';

  it('round-trips the address and the generation it was minted for', async () => {
    const token = await createResetToken(secret, 'alice@example.com', 3);

    expect(await readResetToken(secret, token)).toEqual({
      ok: true,
      email: 'alice@example.com',
      tokenVersion: 3,
    });
  });

  it('survives an address full of dots', async () => {
    // The payload is three dot-joined fields and addresses contain dots, so the
    // trailing two are peeled off the right rather than split on.
    const token = await createResetToken(secret, 'a.b.c@mail.example.co.uk', 0);

    expect(await readResetToken(secret, token)).toMatchObject({ email: 'a.b.c@mail.example.co.uk' });
  });

  it('expires after an hour', async () => {
    const issued = new Date('2026-01-01T00:00:00.000Z');
    const token = await createResetToken(secret, 'alice@example.com', 0, issued);

    const justBefore = new Date(issued.getTime() + (RESET_TTL_SECONDS - 1) * 1000);
    const justAfter = new Date(issued.getTime() + (RESET_TTL_SECONDS + 1) * 1000);

    expect(await readResetToken(secret, token, justBefore)).toMatchObject({ ok: true });
    expect(await readResetToken(secret, token, justAfter)).toEqual({ ok: false, reason: 'expired' });
  });

  it('rejects a token signed for another purpose', async () => {
    // Invite codes are the same shape and the same signer. Without a distinct
    // prefix in what is signed, one could be presented as the other — and an
    // invite link is handed around a group chat.
    const invite = await createInviteCode(secret, 'alice@example.com', 1);

    expect(await readResetToken(secret, invite)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('rejects a tampered generation or a different secret', async () => {
    const token = await createResetToken(secret, 'alice@example.com', 1);
    const [body, signature] = token.split('.');
    const decoded = new TextDecoder().decode(
      Uint8Array.from(atob(body.replaceAll('-', '+').replaceAll('_', '/')), (c) => c.charCodeAt(0)),
    );
    const forged = btoa(decoded.replace('.1.', '.0.'))
      .replaceAll('+', '-')
      .replaceAll('/', '_')
      .replaceAll('=', '');

    expect(await readResetToken(secret, `${forged}.${signature}`)).toEqual({ ok: false, reason: 'invalid' });
    expect(await readResetToken('a-different-secret', token)).toEqual({ ok: false, reason: 'invalid' });
  });
});

describe('the reset email', () => {
  it('says that ignoring it is safe, because most of them are unexpected', async () => {
    const { buildResetEmail } = await import('../src/email');
    const message = buildResetEmail('alice@example.com', 'Alice', 'https://example.com/reset#token=abc');

    expect(message.text).toContain('https://example.com/reset#token=abc');
    expect(message.html).toContain('https://example.com/reset#token=abc');
    // The likeliest recipient of one they did not ask for is someone whose
    // address an attacker typed into the form.
    expect(message.text).toContain('nothing has happened');
    expect(message.text).toContain('has not been changed');
    expect(message.text).toContain('within the next hour');
  });

  it('escapes a display name into the HTML body', async () => {
    const { buildResetEmail } = await import('../src/email');
    const message = buildResetEmail('a@example.com', '<script>alert(1)</script>', 'https://example.com/x');

    expect(message.html).not.toContain('<script>');
    expect(message.html).toContain('&lt;script&gt;');
  });

  it('is not configured without an API key, and says so rather than pretending', async () => {
    const { emailConfig } = await import('../src/email');

    expect(emailConfig({})).toBeNull();
    expect(emailConfig({ BREVO_API_KEY: 'k' })).toMatchObject({ fromName: 'Quotes Journal' });
  });
});
