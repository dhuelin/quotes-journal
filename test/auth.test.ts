import { describe, expect, it } from 'vitest';
import {
  createInviteCode,
  createSessionToken,
  hashPassword,
  readInviteCode,
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
    expect(await verifySessionToken(secret, token)).toEqual(user);
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
    const token = await createSessionToken(secret, user, issued);
    const afterExpiry = new Date(issued.getTime() + (SESSION_TTL_SECONDS + 1) * 1000);

    expect(await verifySessionToken(secret, token, afterExpiry)).toBeNull();
    expect(await verifySessionToken(secret, token, issued)).toEqual(user);
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
    expect(await readInviteCode(secret, code)).toEqual({ groupId: 'group-123', version: 2 });
  });

  it('survives group ids containing dots', async () => {
    const code = await createInviteCode(secret, 'group.with.dots', 1);
    expect(await readInviteCode(secret, code)).toEqual({ groupId: 'group.with.dots', version: 1 });
  });

  it('rejects forged or foreign codes', async () => {
    const code = await createInviteCode(secret, 'group-123', 1);

    expect(await readInviteCode('other-secret', code)).toBeNull();
    expect(await readInviteCode(secret, 'garbage')).toBeNull();
    expect(await readInviteCode(secret, `${code}x`)).toBeNull();
  });
});
