import { describe, expect, it } from 'vitest';
import { env, runInDurableObject, SELF } from 'cloudflare:test';
import { groupByteSize, LIMITS, type GroupState, type Quote } from '../src/domain';
import {
  createInviteCode,
  DEFAULT_PBKDF2_ITERATIONS,
  hashPassword,
  INVITE_TTL_SECONDS,
  readHashIterations,
} from '../src/auth';
import type { UserRecord } from '../src/user-store';
import type { GroupStore } from '../src/group-store';
import { createGroup, registerUser, request, unlockGroup, uniqueIp, type TestUser } from './helpers';

const nextYear = new Date().getUTCFullYear();

/** Matches the AUTH_SECRET the workers pool binds in vitest.config.ts. */
const TEST_SECRET = 'test-secret-not-used-in-production';

const inviteCodeFor = async (owner: TestUser, groupId: string): Promise<string> => {
  const response = await request(`/api/groups/${groupId}/invite`, { token: owner.token });
  expect(response.status).toBe(200);
  return response.body.inviteCode as string;
};

const accountStub = (user: TestUser) => env.USERS.get(env.USERS.idFromName(user.user.email));

/** Fills an account to the group cap without paying for 50 real groups. */
const fillAccountToGroupCap = async (user: TestUser): Promise<void> => {
  await runInDurableObject(accountStub(user), async (_instance, state) => {
    const record = (await state.storage.get<UserRecord>('user')) as UserRecord;
    record.groups = Array.from({ length: LIMITS.groupsPerUser }, (_unused, index) => ({
      groupId: `filler-${index}`,
      name: 'Filler',
      revealYear: nextYear,
      role: 'member' as const,
      joinedAt: new Date().toISOString(),
    }));
    await state.storage.put('user', record);
  });
};

describe('static surface', () => {
  it('serves the app shell on every entry point', async () => {
    for (const path of ['/', '/app', '/join?invite=abc']) {
      const response = await SELF.fetch(`https://example.com${path}`);
      expect(response.status, path).toBe(200);
      expect(await response.text(), path).toContain('Quotes Journal');
    }
  });

  it('serves the PWA manifest, service worker and icon', async () => {
    const manifest = await SELF.fetch('https://example.com/manifest.webmanifest');
    expect(manifest.status).toBe(200);
    expect(await manifest.json()).toMatchObject({ start_url: '/app', display: 'standalone' });

    const serviceWorker = await SELF.fetch('https://example.com/sw.js');
    expect(serviceWorker.status).toBe(200);
    expect(await serviceWorker.text()).toContain('self.addEventListener');

    const icon = await SELF.fetch('https://example.com/icon.svg');
    expect(icon.status).toBe(200);
    expect(icon.headers.get('content-type')).toContain('image/svg+xml');
  });

  it('returns JSON for unknown routes', async () => {
    const response = await request('/api/nope');
    expect(response.status).toBe(404);
    expect(response.body.error).toBe('Not found');
  });
});

describe('accounts', () => {
  it('registers an account and returns a working session', async () => {
    const alice = await registerUser('Alice');

    expect(alice.token).toBeTruthy();
    expect(alice.user.displayName).toBe('Alice');

    const me = await request('/api/auth/me', { token: alice.token });
    expect(me.status).toBe(200);
    expect(me.body.user.id).toBe(alice.user.id);
    expect(me.body.groups).toEqual([]);
  });

  it('never returns the password hash', async () => {
    const alice = await registerUser('Alice');
    const me = await request('/api/auth/me', { token: alice.token });

    expect(JSON.stringify(me.body)).not.toContain('pbkdf2');
  });

  it('refuses a second registration for the same email', async () => {
    const email = `duplicate${Date.now()}@example.com`;
    const payload = { displayName: 'First', email, password: 'a long enough password' };

    const first = await request('/api/auth/register', { method: 'POST', body: payload });
    const second = await request('/api/auth/register', {
      method: 'POST',
      body: { ...payload, displayName: 'Second' },
    });

    expect(first.status).toBe(201);
    expect(second.status).toBe(409);
  });

  it('treats email as case-insensitive when signing in', async () => {
    const email = `Mixed.Case${Date.now()}@Example.com`;
    await request('/api/auth/register', {
      method: 'POST',
      body: { displayName: 'Mixed', email, password: 'a long enough password' },
    });

    const login = await request('/api/auth/login', {
      method: 'POST',
      body: { email: email.toUpperCase(), password: 'a long enough password' },
    });

    expect(login.status).toBe(200);
    expect(login.body.token).toBeTruthy();
  });

  it('rejects a wrong password and an unknown account identically', async () => {
    const email = `known${Date.now()}@example.com`;
    await request('/api/auth/register', {
      method: 'POST',
      body: { displayName: 'Known', email, password: 'a long enough password' },
    });

    const wrongPassword = await request('/api/auth/login', {
      method: 'POST',
      body: { email, password: 'the wrong password' },
    });
    const unknownAccount = await request('/api/auth/login', {
      method: 'POST',
      body: { email: `missing${Date.now()}@example.com`, password: 'the wrong password' },
    });

    expect(wrongPassword.status).toBe(401);
    expect(unknownAccount.status).toBe(401);
    expect(wrongPassword.body.error).toBe(unknownAccount.body.error);
  });

  it('rejects weak or malformed registrations', async () => {
    const cases = [
      { displayName: 'Ok', email: 'not-an-email', password: 'a long enough password' },
      { displayName: 'Ok', email: 'ok@example.com', password: 'short' },
      { displayName: 'A', email: 'ok@example.com', password: 'a long enough password' },
    ];

    for (const body of cases) {
      const response = await request('/api/auth/register', { method: 'POST', body });
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
  });
});

describe('authentication guards', () => {
  it('refuses group access without a token', async () => {
    for (const path of ['/api/groups', '/api/auth/me', '/api/groups/anything']) {
      const response = await request(path);
      expect(response.status, path).toBe(401);
    }
  });

  it('refuses a forged or malformed token', async () => {
    const response = await request('/api/groups', { token: 'not.a.real.token' });
    expect(response.status).toBe(401);
  });
});

describe('groups', () => {
  it('creates a group with the creator as owner and lists it on the account', async () => {
    const alice = await registerUser('Alice');
    const group = await createGroup(alice, 'Sunday football crew', nextYear);

    expect(group.name).toBe('Sunday football crew');
    expect(group.locked).toBe(true);
    expect(group.you.role).toBe('owner');
    expect(group.members).toHaveLength(1);
    expect(group.members[0]).toMatchObject({ name: 'Alice', isYou: true });

    const account = await request('/api/auth/me', { token: alice.token });
    expect(account.body.groups).toHaveLength(1);
    expect(account.body.groups[0]).toMatchObject({ groupId: group.id, role: 'owner' });
  });

  it('rejects a reveal year in the past, so no group starts unlocked', async () => {
    const alice = await registerUser('Alice');
    const response = await request('/api/groups', {
      method: 'POST',
      token: alice.token,
      body: { name: 'Backdated', revealYear: 2000 },
    });

    expect(response.status).toBe(400);
    expect(response.body.error).toContain('Reveal year');
  });

  it('rejects an over-long group name', async () => {
    const alice = await registerUser('Alice');
    const response = await request('/api/groups', {
      method: 'POST',
      token: alice.token,
      body: { name: 'x'.repeat(LIMITS.groupName + 1), revealYear: nextYear },
    });

    expect(response.status).toBe(400);
  });

  it('hides a group from anyone who is not a member', async () => {
    const alice = await registerUser('Alice');
    const stranger = await registerUser('Stranger');
    const group = await createGroup(alice, 'Private jokes', nextYear);

    const peek = await request(`/api/groups/${group.id}`, { token: stranger.token });
    expect(peek.status).toBe(404);

    const write = await request(`/api/groups/${group.id}/quotes`, {
      method: 'POST',
      token: stranger.token,
      body: { text: 'Let me in', saidByMemberId: group.you.memberId },
    });
    expect(write.status).toBe(404);
  });
});

describe('invites', () => {
  const invite = async (owner: TestUser, groupId: string) => {
    const response = await request(`/api/groups/${groupId}/invite`, { token: owner.token });
    expect(response.status).toBe(200);
    return response.body as { inviteCode: string };
  };

  it('lets an invited user join and see the group', async () => {
    const alice = await registerUser('Alice');
    const bob = await registerUser('Bob');
    const group = await createGroup(alice, 'Invite crew', nextYear);

    const { inviteCode } = await invite(alice, group.id);

    const joined = await request('/api/invites/accept', {
      method: 'POST',
      token: bob.token,
      body: { inviteCode },
    });

    expect(joined.status).toBe(201);
    expect(joined.body.group.members).toHaveLength(2);
    expect(joined.body.group.you.role).toBe('member');

    const bobsGroups = await request('/api/auth/me', { token: bob.token });
    expect(bobsGroups.body.groups).toHaveLength(1);
  });

  it('is idempotent when the same user accepts twice', async () => {
    const alice = await registerUser('Alice');
    const bob = await registerUser('Bob');
    const group = await createGroup(alice, 'Twice crew', nextYear);
    const { inviteCode } = await invite(alice, group.id);

    await request('/api/invites/accept', { method: 'POST', token: bob.token, body: { inviteCode } });
    const again = await request('/api/invites/accept', { method: 'POST', token: bob.token, body: { inviteCode } });

    expect(again.status).toBe(200);
    expect(again.body.group.members).toHaveLength(2);
  });

  it('rejects a forged invite code', async () => {
    const bob = await registerUser('Bob');
    const response = await request('/api/invites/accept', {
      method: 'POST',
      token: bob.token,
      body: { inviteCode: 'Z3JvdXAtMTIzLjE.forgedsignature' },
    });

    expect(response.status).toBe(400);
  });

  it('invalidates old links once the owner rotates the invite', async () => {
    const alice = await registerUser('Alice');
    const bob = await registerUser('Bob');
    const group = await createGroup(alice, 'Rotating crew', nextYear);
    const original = await invite(alice, group.id);

    const rotated = await request(`/api/groups/${group.id}/invite/rotate`, {
      method: 'POST',
      token: alice.token,
      body: {},
    });
    expect(rotated.status).toBe(200);
    expect(rotated.body.inviteCode).not.toBe(original.inviteCode);

    const stale = await request('/api/invites/accept', {
      method: 'POST',
      token: bob.token,
      body: { inviteCode: original.inviteCode },
    });
    expect(stale.status).toBe(410);

    const fresh = await request('/api/invites/accept', {
      method: 'POST',
      token: bob.token,
      body: { inviteCode: rotated.body.inviteCode },
    });
    expect(fresh.status).toBe(201);
  });

  it('only lets the owner rotate the invite', async () => {
    const alice = await registerUser('Alice');
    const bob = await registerUser('Bob');
    const group = await createGroup(alice, 'Owner only', nextYear);
    const { inviteCode } = await invite(alice, group.id);
    await request('/api/invites/accept', { method: 'POST', token: bob.token, body: { inviteCode } });

    const attempt = await request(`/api/groups/${group.id}/invite/rotate`, {
      method: 'POST',
      token: bob.token,
      body: {},
    });

    expect(attempt.status).toBe(403);
  });
});

describe('members and quotes', () => {
  it('adds guest members who can be quoted without an account', async () => {
    const alice = await registerUser('Alice');
    const group = await createGroup(alice, 'Guests welcome', nextYear);

    const added = await request(`/api/groups/${group.id}/members`, {
      method: 'POST',
      token: alice.token,
      body: { name: 'Cleo' },
    });
    expect(added.status).toBe(201);

    const refreshed = await request(`/api/groups/${group.id}`, { token: alice.token });
    expect(refreshed.body.group.members).toHaveLength(2);
    expect(refreshed.body.group.members[1]).toMatchObject({ name: 'Cleo', isGuest: true });
  });

  it('refuses duplicate member names in one group', async () => {
    const alice = await registerUser('Alice');
    const group = await createGroup(alice, 'No twins', nextYear);

    await request(`/api/groups/${group.id}/members`, { method: 'POST', token: alice.token, body: { name: 'Cleo' } });
    const duplicate = await request(`/api/groups/${group.id}/members`, {
      method: 'POST',
      token: alice.token,
      body: { name: 'cleo' },
    });

    expect(duplicate.status).toBe(409);
  });

  it('stores a quote and counts it without revealing the text', async () => {
    const alice = await registerUser('Alice');
    const group = await createGroup(alice, 'Vault', nextYear);

    const saved = await request(`/api/groups/${group.id}/quotes`, {
      method: 'POST',
      token: alice.token,
      body: { text: 'I am not lost, the map is wrong', saidByMemberId: group.you.memberId },
    });

    expect(saved.status).toBe(201);
    expect(JSON.stringify(saved.body)).not.toContain('the map is wrong');

    const refreshed = await request(`/api/groups/${group.id}`, { token: alice.token });
    expect(refreshed.body.group.progress).toMatchObject({ totalQuotes: 1, recordedByYou: 1 });
  });

  it('rejects quotes about members of another group', async () => {
    const alice = await registerUser('Alice');
    const group = await createGroup(alice, 'Group A', nextYear);
    const other = await createGroup(alice, 'Group B', nextYear);

    const response = await request(`/api/groups/${group.id}/quotes`, {
      method: 'POST',
      token: alice.token,
      body: { text: 'Wrong group', saidByMemberId: other.you.memberId },
    });

    expect(response.status).toBe(400);
    expect(response.body.error).toContain('not part of this group');
  });

  it('rejects an empty or over-long quote', async () => {
    const alice = await registerUser('Alice');
    const group = await createGroup(alice, 'Length checks', nextYear);

    for (const text of ['   ', 'x'.repeat(LIMITS.quoteText + 1)]) {
      const response = await request(`/api/groups/${group.id}/quotes`, {
        method: 'POST',
        token: alice.token,
        body: { text, saidByMemberId: group.you.memberId },
      });
      expect(response.status).toBe(400);
    }
  });

  it('rejects a request body over the size cap', async () => {
    const alice = await registerUser('Alice');
    const group = await createGroup(alice, 'Big body', nextYear);

    const response = await request(`/api/groups/${group.id}/quotes`, {
      method: 'POST',
      token: alice.token,
      body: { text: 'ok', saidByMemberId: group.you.memberId, padding: 'x'.repeat(LIMITS.requestBytes) },
    });

    expect(response.status).toBe(400);
    expect(response.body.error).toContain('too large');
  });

  it('attributes the quote to the caller, ignoring a spoofed recordedByMemberId', async () => {
    const alice = await registerUser('Alice');
    const bob = await registerUser('Bob');
    const group = await createGroup(alice, 'Attribution', nextYear);

    const inviteResponse = await request(`/api/groups/${group.id}/invite`, { token: alice.token });
    const joined = await request('/api/invites/accept', {
      method: 'POST',
      token: bob.token,
      body: { inviteCode: inviteResponse.body.inviteCode },
    });
    const bobMemberId = joined.body.group.you.memberId;

    await request(`/api/groups/${group.id}/quotes`, {
      method: 'POST',
      token: bob.token,
      body: {
        text: 'Bob wrote this down',
        saidByMemberId: group.you.memberId,
        recordedByMemberId: group.you.memberId,
      },
    });

    await unlockGroup(group.id);
    const stats = await request(`/api/groups/${group.id}/stats`, { token: alice.token });

    expect(stats.body.persistedBy[bobMemberId]).toBe(1);
    expect(stats.body.persistedBy[group.you.memberId]).toBe(0);
    expect(stats.body.saidBy[group.you.memberId]).toBe(1);
  });
});

describe('the year-end lock', () => {
  it('keeps quotes, quiz and stats sealed while the year runs', async () => {
    const alice = await registerUser('Alice');
    const group = await createGroup(alice, 'Sealed', nextYear);

    for (const path of ['quotes', 'quiz', 'stats']) {
      const response = await request(`/api/groups/${group.id}/${path}`, { token: alice.token });
      expect(response.status, path).toBe(423);
      expect(response.body.revealAt, path).toBe(`${nextYear + 1}-01-01T00:00:00.000Z`);
    }
  });

  it('opens everything once the reveal date has passed', async () => {
    const alice = await registerUser('Alice');
    const group = await createGroup(alice, 'Opened', nextYear);

    await request(`/api/groups/${group.id}/members`, { method: 'POST', token: alice.token, body: { name: 'Cleo' } });
    const withCleo = await request(`/api/groups/${group.id}`, { token: alice.token });
    const cleo = withCleo.body.group.members.find((member: { name: string }) => member.name === 'Cleo');

    await request(`/api/groups/${group.id}/quotes`, {
      method: 'POST',
      token: alice.token,
      body: { text: 'The map is wrong', saidByMemberId: cleo.id, involvedMemberIds: [group.you.memberId] },
    });

    await unlockGroup(group.id);

    const quotes = await request(`/api/groups/${group.id}/quotes`, { token: alice.token });
    expect(quotes.status).toBe(200);
    expect(quotes.body.quotes).toHaveLength(1);
    expect(quotes.body.quotes[0].text).toBe('The map is wrong');

    const quiz = await request(`/api/groups/${group.id}/quiz`, { token: alice.token });
    expect(quiz.status).toBe(200);
    expect(quiz.body.questions).toHaveLength(1);
    expect(quiz.body.questions[0].answerMemberId).toBe(cleo.id);
    expect(quiz.body.questions[0].options).toHaveLength(2);

    const stats = await request(`/api/groups/${group.id}/stats`, { token: alice.token });
    expect(stats.status).toBe(200);
    expect(stats.body.saidBy[cleo.id]).toBe(1);
    expect(stats.body.persistedBy[group.you.memberId]).toBe(1);
    expect(stats.body.leaderboard[0]).toMatchObject({ name: 'Cleo', said: 1 });

    const overview = await request(`/api/groups/${group.id}`, { token: alice.token });
    expect(overview.body.group.locked).toBe(false);
  });
});

describe('rate limiting', () => {
  it('blocks a login flood from one address with a Retry-After hint', async () => {
    const ip = `203.0.113.${Math.floor(Math.random() * 250)}`;
    const body = { email: `flood${Date.now()}@example.com`, password: 'a long enough password' };

    let sawTooMany = false;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const response = await SELF.fetch('https://example.com/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip },
        body: JSON.stringify(body),
      });

      if (response.status === 429) {
        sawTooMany = true;
        expect(Number(response.headers.get('retry-after'))).toBeGreaterThan(0);
        break;
      }

      expect(response.status).toBe(401);
    }

    expect(sawTooMany).toBe(true);
  });

  it('keeps separate buckets per address', async () => {
    const body = { email: `neighbour${Date.now()}@example.com`, password: 'a long enough password' };

    const first = await request('/api/auth/login', { method: 'POST', body, ip: uniqueIp() });
    const second = await request('/api/auth/login', { method: 'POST', body, ip: uniqueIp() });

    expect(first.status).toBe(401);
    expect(second.status).toBe(401);
  });
});


describe('guest slots cannot be claimed by joining (H1)', () => {
  it('refuses a joiner whose display name matches a guest, leaving the guest intact', async () => {
    const alice = await registerUser('Alice');
    const group = await createGroup(alice, 'Guest slot', nextYear);

    await request(`/api/groups/${group.id}/members`, { method: 'POST', token: alice.token, body: { name: 'Bob' } });
    const before = await request(`/api/groups/${group.id}`, { token: alice.token });
    const guest = before.body.group.members.find((member: { name: string }) => member.name === 'Bob');

    // The quote the hijack used to inherit along with the member id.
    await request(`/api/groups/${group.id}/quotes`, {
      method: 'POST',
      token: alice.token,
      body: { text: 'Something guest Bob said', saidByMemberId: guest.id },
    });

    // Trimmed and case-folded to exactly the guest's name.
    const impostor = await registerUser('  bob  ');
    const inviteCode = await inviteCodeFor(alice, group.id);
    const joined = await request('/api/invites/accept', {
      method: 'POST',
      token: impostor.token,
      body: { inviteCode },
    });

    expect(joined.status).toBe(409);
    expect(joined.body.error).toContain('already goes by that name');
    expect(joined.body.nameTaken).toBe(true);

    const after = await request(`/api/groups/${group.id}`, { token: alice.token });
    const stillGuest = after.body.group.members.find((member: { name: string }) => member.name === 'Bob');
    expect(after.body.group.members).toHaveLength(2);
    expect(stillGuest.id).toBe(guest.id);
    expect(stillGuest.isGuest).toBe(true);

    // The impostor is not in the group at all, so the quote is still the guest's.
    const peek = await request(`/api/groups/${group.id}`, { token: impostor.token });
    expect(peek.status).toBe(404);
  });

  it('always gives a joining account a member row of its own', async () => {
    const alice = await registerUser('Alice');
    const dana = await registerUser('Dana');
    const group = await createGroup(alice, 'Fresh rows', nextYear);

    await request(`/api/groups/${group.id}/members`, { method: 'POST', token: alice.token, body: { name: 'Cleo' } });
    const before = await request(`/api/groups/${group.id}`, { token: alice.token });
    const cleo = before.body.group.members.find((member: { name: string }) => member.name === 'Cleo');

    const inviteCode = await inviteCodeFor(alice, group.id);
    const joined = await request('/api/invites/accept', { method: 'POST', token: dana.token, body: { inviteCode } });

    expect(joined.status).toBe(201);
    expect(joined.body.group.you.memberId).not.toBe(cleo.id);
    expect(joined.body.group.members).toHaveLength(3);

    const guestAfter = joined.body.group.members.find((member: { name: string }) => member.name === 'Cleo');
    expect(guestAfter.isGuest).toBe(true);
  });
});

describe('duplicate display names (M3)', () => {
  it('refuses a second member arriving under a name already in the group', async () => {
    const alice = await registerUser('Alice');
    const first = await registerUser('Sam');
    const second = await registerUser('Sam');
    const group = await createGroup(alice, 'One Sam only', nextYear);
    const inviteCode = await inviteCodeFor(alice, group.id);

    const accepted = await request('/api/invites/accept', { method: 'POST', token: first.token, body: { inviteCode } });
    const duplicate = await request('/api/invites/accept', {
      method: 'POST',
      token: second.token,
      body: { inviteCode },
    });

    expect(accepted.status).toBe(201);
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error).toContain('already goes by that name');
    expect(accepted.body.group.members).toHaveLength(2);
  });
});

describe('auth rate limiting per account (H2, M4)', () => {
  it('blocks a password flood that rotates the client IP header', async () => {
    const email = `rotator${Date.now()}@example.com`;

    let sawTooMany = false;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      // A new address every time: the per-IP bucket can never fire here.
      const response = await request('/api/auth/login', {
        method: 'POST',
        ip: uniqueIp(),
        body: { email, password: 'a long enough password' },
      });

      if (response.status === 429) {
        sawTooMany = true;
        break;
      }
      expect(response.status).toBe(401);
    }

    expect(sawTooMany).toBe(true);
  });

  it('answers a blocked account exactly like a blocked address', async () => {
    const email = `twins${Date.now()}@example.com`;
    let byAccount: { status: number; body: any } | null = null;
    for (let attempt = 0; attempt < 10 && !byAccount; attempt += 1) {
      const response = await request('/api/auth/login', {
        method: 'POST',
        ip: uniqueIp(),
        body: { email, password: 'a long enough password' },
      });
      byAccount = response.status === 429 ? response : null;
    }

    const ip = uniqueIp();
    let byAddress: { status: number; body: any } | null = null;
    for (let attempt = 0; attempt < 16 && !byAddress; attempt += 1) {
      const response = await request('/api/auth/login', {
        method: 'POST',
        ip,
        body: { email: `flood${Date.now()}x${attempt}@example.com`, password: 'a long enough password' },
      });
      byAddress = response.status === 429 ? response : null;
    }

    expect(byAccount).not.toBeNull();
    expect(byAddress).not.toBeNull();
    expect(byAccount?.status).toBe(byAddress?.status);
    // Same wording either way, so the response never says whether the address
    // is registered. The retry hint does differ, because the two buckets have
    // different windows — that reveals which limit fired, not who exists.
    expect(byAccount?.body.error).toBe(byAddress?.body.error);
    expect(byAccount?.body.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('never spends the account budget on a correct sign-in', async () => {
    // Signing in on several devices used to lock the owner out of their own
    // account, because the bucket was consumed whether or not the attempt
    // succeeded. Ten correct logins in a row must all pass.
    const user = await registerUser('Repeat');
    const email = user.user.email;

    for (let attempt = 0; attempt < 10; attempt += 1) {
      const response = await request('/api/auth/login', {
        method: 'POST',
        ip: uniqueIp(),
        body: { email, password: 'correct horse battery staple' },
      });
      expect(response.status, `attempt ${attempt}`).toBe(200);
    }
  });

  it('blocks the attacking client without locking the owner out', async () => {
    const user = await registerUser('Victim');
    const email = user.user.email;
    const attacker = uniqueIp();

    // One attacker, guessing from one client, until their narrow bucket is dry.
    let attackerBlocked = false;
    for (let attempt = 0; attempt < 8 && !attackerBlocked; attempt += 1) {
      const response = await request('/api/auth/login', {
        method: 'POST',
        ip: attacker,
        body: { email, password: 'not the right password' },
      });
      attackerBlocked = response.status === 429;
    }

    expect(attackerBlocked).toBe(true);

    // The narrow bucket is keyed on address *and* client, so the owner signing
    // in from their own machine is untouched by the attack.
    const owner = await request('/api/auth/login', {
      method: 'POST',
      ip: uniqueIp(),
      body: { email, password: 'correct horse battery staple' },
    });

    expect(owner.status).toBe(200);
  });

  it('keeps register probes from denying login on the same address', async () => {
    const user = await registerUser('Separate');
    const email = user.user.email;

    // Six register attempts carrying only the address — no password knowledge.
    for (let attempt = 0; attempt < 6; attempt += 1) {
      await request('/api/auth/register', {
        method: 'POST',
        ip: uniqueIp(),
        body: { displayName: 'Probe', email, password: 'a long enough password' },
      });
    }

    const owner = await request('/api/auth/login', {
      method: 'POST',
      ip: uniqueIp(),
      body: { email, password: 'correct horse battery staple' },
    });

    expect(owner.status).toBe(200);
  });

  it('throttles repeated probing of one address, even from many client IPs', async () => {
    const email = `enumerate${Date.now()}@example.com`;
    const body = { displayName: 'Probe', email, password: 'a long enough password' };

    const statuses: number[] = [];
    for (let attempt = 0; attempt < 12; attempt += 1) {
      statuses.push((await request('/api/auth/register', { method: 'POST', ip: uniqueIp(), body })).status);
    }

    expect(statuses[0]).toBe(201);
    expect(statuses).toContain(409);
    // A rotating IP earns a fresh narrow bucket every time, so the address-wide
    // budget is the only thing left to bite — and it does.
    expect(statuses).toContain(429);
  });

  it('does not stop enumeration across distinct addresses (known gap, issue #6)', async () => {
    // Every address arrives with a full bucket, so probing many addresses once
    // each is limited only by the per-IP budget. Asserted so the gap stays
    // visible rather than being mistaken for something these buckets cover.
    const stamp = Date.now();
    const taken = `known${stamp}@example.com`;
    await request('/api/auth/register', {
      method: 'POST',
      body: { displayName: 'Known', email: taken, password: 'a long enough password' },
    });

    const probe = (email: string) =>
      request('/api/auth/register', {
        method: 'POST',
        ip: uniqueIp(),
        body: { displayName: 'Probe', email, password: 'a long enough password' },
      });

    expect((await probe(taken)).status).toBe(409);
    expect((await probe(`free${stamp}@example.com`)).status).toBe(201);
  });
});

describe('password hash upgrades (M1)', () => {
  const storedHash = async (user: TestUser): Promise<string> =>
    runInDurableObject(
      accountStub(user),
      async (_instance, state) => ((await state.storage.get<UserRecord>('user')) as UserRecord).passwordHash,
    );

  it('re-hashes on login when the stored rounds are below the configured count', async () => {
    const user = await registerUser('Upgradable');
    const outdated = await hashPassword('correct horse battery staple', 11_000);

    await runInDurableObject(accountStub(user), async (_instance, state) => {
      const record = (await state.storage.get<UserRecord>('user')) as UserRecord;
      record.passwordHash = outdated;
      await state.storage.put('user', record);
    });

    const login = await request('/api/auth/login', {
      method: 'POST',
      body: { email: user.user.email, password: 'correct horse battery staple' },
    });

    expect(login.status).toBe(200);
    expect(readHashIterations(await storedHash(user))).toBe(DEFAULT_PBKDF2_ITERATIONS);
  });

  it('leaves a hash that already matches the configured count alone', async () => {
    const user = await registerUser('Current');
    const before = await storedHash(user);

    const login = await request('/api/auth/login', {
      method: 'POST',
      body: { email: user.user.email, password: 'correct horse battery staple' },
    });

    expect(login.status).toBe(200);
    expect(await storedHash(user)).toBe(before);
  });
});

describe('owner-approved guest claims (S2)', () => {
  /** Owner with a guest row, plus a second account that has joined the group. */
  const groupWithGuestAndJoiner = async () => {
    const owner = await registerUser('Owner');
    const joiner = await registerUser('Joiner');
    const group = await createGroup(owner, 'Claimable', nextYear);

    const guest = await request(`/api/groups/${group.id}/members`, {
      method: 'POST',
      token: owner.token,
      body: { name: 'Bob' },
    });
    expect(guest.status).toBe(201);

    const inviteCode = await inviteCodeFor(owner, group.id);
    const joined = await request('/api/invites/accept', {
      method: 'POST',
      token: joiner.token,
      body: { inviteCode, memberName: 'Bob (new)' },
    });
    expect(joined.status).toBe(201);

    return { owner, joiner, group, guestMemberId: guest.body.member.id as string, joined };
  };

  it('lets a joiner past a taken name by choosing another one', async () => {
    const owner = await registerUser('Owner');
    const bob = await registerUser('Bob');
    const group = await createGroup(owner, 'Name clash', nextYear);

    await request(`/api/groups/${group.id}/members`, {
      method: 'POST',
      token: owner.token,
      body: { name: 'Bob' },
    });
    const inviteCode = await inviteCodeFor(owner, group.id);

    // The bare join collides, and says so in a way the client can act on.
    const collision = await request('/api/invites/accept', {
      method: 'POST',
      token: bob.token,
      body: { inviteCode },
    });
    expect(collision.status).toBe(409);
    expect(collision.body.nameTaken).toBe(true);

    // Naming himself differently for this group gets him in.
    const retry = await request('/api/invites/accept', {
      method: 'POST',
      token: bob.token,
      body: { inviteCode, memberName: 'Bob B' },
    });
    expect(retry.status).toBe(201);
    expect(retry.body.group.you.name).toBe('Bob B');
  });

  it('folds a joined account into the guest row, carrying its quotes across', async () => {
    const { owner, joiner, group, guestMemberId, joined } = await groupWithGuestAndJoiner();
    const joinerMemberId = joined.body.group.you.memberId as string;

    // A quote said by the guest and one recorded by the joiner's own row.
    await request(`/api/groups/${group.id}/quotes`, {
      method: 'POST',
      token: owner.token,
      body: { text: 'Said before he signed up', saidByMemberId: guestMemberId },
    });
    await request(`/api/groups/${group.id}/quotes`, {
      method: 'POST',
      token: joiner.token,
      body: { text: 'Recorded after he signed up', saidByMemberId: guestMemberId },
    });

    const claim = await request(`/api/groups/${group.id}/members/claim`, {
      method: 'POST',
      token: owner.token,
      body: { guestMemberId, memberId: joinerMemberId },
    });
    expect(claim.status).toBe(200);

    // One row survives, and it is the guest's.
    const members = claim.body.group.members as Array<{ id: string; isGuest: boolean }>;
    expect(members.map((entry) => entry.id)).toContain(guestMemberId);
    expect(members.map((entry) => entry.id)).not.toContain(joinerMemberId);
    expect(members.find((entry) => entry.id === guestMemberId)?.isGuest).toBe(false);

    // The joiner now reaches the group through the guest's row.
    const asJoiner = await request(`/api/groups/${group.id}`, { token: joiner.token });
    expect(asJoiner.status).toBe(200);
    expect(asJoiner.body.group.you.memberId).toBe(guestMemberId);

    // Both quotes point at the surviving row, so nothing was orphaned.
    await unlockGroup(group.id);
    const stats = await request(`/api/groups/${group.id}/stats`, { token: owner.token });
    expect(stats.body.saidBy[guestMemberId]).toBe(2);
    expect(stats.body.persistedBy[guestMemberId]).toBe(1);
  });

  it('only lets the owner claim, rename or remove', async () => {
    const { joiner, group, guestMemberId, joined } = await groupWithGuestAndJoiner();
    const joinerMemberId = joined.body.group.you.memberId as string;

    const attempts = [
      ['/members/claim', { guestMemberId, memberId: joinerMemberId }],
      ['/members/rename', { memberId: guestMemberId, name: 'Renamed' }],
      ['/members/remove', { memberId: guestMemberId }],
      ['/members', { name: 'Sneaky' }],
    ] as const;

    for (const [path, body] of attempts) {
      const response = await request(`/api/groups/${group.id}${path}`, {
        method: 'POST',
        token: joiner.token,
        body,
      });
      expect(response.status, path).toBe(403);
    }
  });

  it('refuses to claim a row that already belongs to an account', async () => {
    const { owner, group, guestMemberId, joined } = await groupWithGuestAndJoiner();
    const joinerMemberId = joined.body.group.you.memberId as string;

    await request(`/api/groups/${group.id}/members/claim`, {
      method: 'POST',
      token: owner.token,
      body: { guestMemberId, memberId: joinerMemberId },
    });

    const again = await request(`/api/groups/${group.id}/members/claim`, {
      method: 'POST',
      token: owner.token,
      body: { guestMemberId, memberId: joinerMemberId },
    });

    expect(again.status).toBe(404);
  });

  it('frees a squatted name by renaming or removing the squatter', async () => {
    const owner = await registerUser('Owner');
    const group = await createGroup(owner, 'Squatted', nextYear);

    const squatter = await request(`/api/groups/${group.id}/members`, {
      method: 'POST',
      token: owner.token,
      body: { name: 'Dave' },
    });
    const squatterId = squatter.body.member.id as string;

    const renamed = await request(`/api/groups/${group.id}/members/rename`, {
      method: 'POST',
      token: owner.token,
      body: { memberId: squatterId, name: 'Not Dave' },
    });
    expect(renamed.status).toBe(200);

    const removed = await request(`/api/groups/${group.id}/members/remove`, {
      method: 'POST',
      token: owner.token,
      body: { memberId: squatterId },
    });
    expect(removed.status).toBe(200);
    expect(removed.body.group.members).toHaveLength(1);
  });

  it('refuses to remove a member who already appears in a quote', async () => {
    const owner = await registerUser('Owner');
    const group = await createGroup(owner, 'Quoted member', nextYear);

    const guest = await request(`/api/groups/${group.id}/members`, {
      method: 'POST',
      token: owner.token,
      body: { name: 'Quoted' },
    });
    const guestId = guest.body.member.id as string;

    await request(`/api/groups/${group.id}/quotes`, {
      method: 'POST',
      token: owner.token,
      body: { text: 'Something memorable', saidByMemberId: guestId },
    });

    const removed = await request(`/api/groups/${group.id}/members/remove`, {
      method: 'POST',
      token: owner.token,
      body: { memberId: guestId },
    });

    expect(removed.status).toBe(409);
    expect(removed.body.error).toContain('Rename them instead');
  });

  it('will not remove the owner', async () => {
    const owner = await registerUser('Owner');
    const group = await createGroup(owner, 'Self removal', nextYear);

    const response = await request(`/api/groups/${group.id}/members/remove`, {
      method: 'POST',
      token: owner.token,
      body: { memberId: group.you.memberId },
    });

    expect(response.status).toBe(409);
  });
});

describe('the stored-value ceiling (M2)', () => {
  it('refuses a quote past the byte budget without bricking the rest of the group', async () => {
    const alice = await registerUser('Alice');
    const group = await createGroup(alice, 'Nearly full', nextYear);

    await runInDurableObject(env.GROUPS.get(env.GROUPS.idFromName(group.id)), async (_instance, state) => {
      const stored = (await state.storage.get<GroupState>('group')) as GroupState;
      // Worst-case shape: maximum text plus a full involved-member list. This is
      // what walks past the ceiling long before the 2000-quote count cap bites.
      const filler = (): Quote => ({
        id: crypto.randomUUID(),
        text: 'x'.repeat(LIMITS.quoteText),
        saidByMemberId: group.you.memberId,
        recordedByMemberId: group.you.memberId,
        involvedMemberIds: Array.from({ length: LIMITS.involvedMembers }, () => crypto.randomUUID()),
        createdAt: new Date().toISOString(),
      });

      const perQuote = new TextEncoder().encode(JSON.stringify(filler())).length;
      const room = LIMITS.groupBytes - groupByteSize(stored);
      const count = Math.ceil(room / perQuote);
      expect(count).toBeLessThan(LIMITS.quotesPerGroup);
      stored.quotes = Array.from({ length: count }, filler);
      await state.storage.put('group', stored);
    });

    const rejected = await request(`/api/groups/${group.id}/quotes`, {
      method: 'POST',
      token: alice.token,
      body: { text: 'One quote too many', saidByMemberId: group.you.memberId },
    });

    expect(rejected.status).toBe(409);
    expect(rejected.body.error).toContain('run out of room');

    // The point of the budget: the other write paths still work.
    const member = await request(`/api/groups/${group.id}/members`, {
      method: 'POST',
      token: alice.token,
      body: { name: 'Cleo' },
    });
    expect(member.status).toBe(201);

    const rotated = await request(`/api/groups/${group.id}/invite/rotate`, {
      method: 'POST',
      token: alice.token,
      body: {},
    });
    expect(rotated.status).toBe(200);
  });

  it('answers JSON, not plain text, when a storage write fails outright', async () => {
    const alice = await registerUser('Alice');
    const group = await createGroup(alice, 'Broken storage', nextYear);

    const response = await runInDurableObject(
      env.GROUPS.get(env.GROUPS.idFromName(group.id)),
      async (instance, state) => {
        const original = state.storage.put.bind(state.storage);
        state.storage.put = () => {
          throw new Error('SQLITE_TOOBIG: string or blob too big');
        };

        try {
          return await (instance as GroupStore).fetch(
            new Request('https://group/members', {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                'x-user-id': alice.user.id,
                'x-user-name': alice.user.displayName,
              },
              body: JSON.stringify({ name: 'Cleo' }),
            }),
          );
        } finally {
          state.storage.put = original;
        }
      },
    );

    expect(response.status).toBe(500);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(((await response.json()) as { error: string }).error).toContain('could not be updated');
  });
});

describe('invite links (M5, L2)', () => {
  it('returns the code alone, never a link built from the request host', async () => {
    const alice = await registerUser('Alice');
    const group = await createGroup(alice, 'Host header', nextYear);

    const response = await SELF.fetch(`https://attacker.example.net/api/groups/${group.id}/invite`, {
      headers: { authorization: `Bearer ${alice.token}`, 'cf-connecting-ip': uniqueIp() },
    });
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body.inviteCode).toBeTruthy();
    expect(body.inviteUrl).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('attacker.example.net');
  });

  it('returns the code alone from rotation too', async () => {
    const alice = await registerUser('Alice');
    const group = await createGroup(alice, 'Rotate host', nextYear);

    const rotated = await request(`/api/groups/${group.id}/invite/rotate`, {
      method: 'POST',
      token: alice.token,
      body: {},
    });

    expect(rotated.body.inviteCode).toBeTruthy();
    expect(rotated.body.inviteUrl).toBeUndefined();
  });

  it('rejects an expired code with an error distinct from an invalid one', async () => {
    const alice = await registerUser('Alice');
    const bob = await registerUser('Bob');
    const group = await createGroup(alice, 'Stale invite', nextYear);

    const issuedLongAgo = new Date(Date.now() - (INVITE_TTL_SECONDS + 3600) * 1000);
    const stale = await createInviteCode(TEST_SECRET, group.id, 1, issuedLongAgo);

    const expired = await request('/api/invites/accept', { method: 'POST', token: bob.token, body: { inviteCode: stale } });
    const forged = await request('/api/invites/accept', {
      method: 'POST',
      token: bob.token,
      body: { inviteCode: 'Z3JvdXAtMTIzLjEuMQ.forgedsignature' },
    });

    expect(expired.status).toBe(410);
    expect(expired.body.error).toContain('expired');
    expect(forged.status).toBe(400);
    expect(forged.body.error).not.toBe(expired.body.error);
  });

  it('still accepts a freshly minted code', async () => {
    const alice = await registerUser('Alice');
    const bob = await registerUser('Bob');
    const group = await createGroup(alice, 'Fresh invite', nextYear);
    const inviteCode = await inviteCodeFor(alice, group.id);

    const joined = await request('/api/invites/accept', { method: 'POST', token: bob.token, body: { inviteCode } });
    expect(joined.status).toBe(201);
  });

  it('ships a client that carries the code in the fragment', async () => {
    const shell = await (await SELF.fetch('https://example.com/app')).text();

    expect(shell).toContain("'/join#invite='");
    expect(shell).toContain('location.hash');
    // Cleared from the address bar so it does not linger in history or referrers.
    expect(shell).toContain('history.replaceState');
  });
});

describe('security headers (L1)', () => {
  it('locks the app shell down and allows the inline script and style by nonce', async () => {
    const response = await SELF.fetch('https://example.com/app');
    const csp = response.headers.get('content-security-policy') ?? '';

    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('x-frame-options')).toBe('DENY');
    expect(response.headers.get('strict-transport-security')).toContain('max-age=');

    for (const directive of [
      "default-src 'none'",
      "connect-src 'self'",
      "img-src 'self' data:",
      "manifest-src 'self'",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
    ]) {
      expect(csp, directive).toContain(directive);
    }
    expect(csp).not.toContain("'unsafe-inline'");

    const nonce = /script-src 'nonce-([A-Za-z0-9+/_-]+)'/.exec(csp)?.[1];
    expect(nonce).toBeTruthy();

    const shell = await response.text();
    expect(shell).toContain(`<script nonce="${nonce}">`);
    expect(shell).toContain(`<style nonce="${nonce}">`);
    expect(shell).not.toContain('__CSP_NONCE__');
  });

  it('mints a fresh nonce for every response', async () => {
    const first = await SELF.fetch('https://example.com/app');
    const second = await SELF.fetch('https://example.com/app');

    expect(first.headers.get('content-security-policy')).not.toBe(second.headers.get('content-security-policy'));
  });
});

describe('the group cap (L3)', () => {
  it('refuses to create a group past the cap instead of orphaning one', async () => {
    const alice = await registerUser('Alice');
    await fillAccountToGroupCap(alice);

    const response = await request('/api/groups', {
      method: 'POST',
      token: alice.token,
      body: { name: 'One too many', revealYear: nextYear },
    });

    expect(response.status).toBe(409);
    expect(response.body.error).toContain('at most');

    const account = await request('/api/auth/me', { token: alice.token });
    expect(account.body.groups).toHaveLength(LIMITS.groupsPerUser);
  });

  it('refuses to accept an invite past the cap, without adding a hidden membership', async () => {
    const owner = await registerUser('Owner');
    const joiner = await registerUser('Joiner');
    const group = await createGroup(owner, 'Full up', nextYear);
    const inviteCode = await inviteCodeFor(owner, group.id);
    await fillAccountToGroupCap(joiner);

    const response = await request('/api/invites/accept', {
      method: 'POST',
      token: joiner.token,
      body: { inviteCode },
    });

    expect(response.status).toBe(409);

    const overview = await request(`/api/groups/${group.id}`, { token: owner.token });
    expect(overview.body.group.members).toHaveLength(1);
  });
});

describe('read rate limiting (L4)', () => {
  it('blocks an authenticated read flood from one account', async () => {
    const reader = await registerUser('Reader');

    let sawTooMany = false;
    // The pool pins RATE_LIMIT_READ low, so this settles in a few dozen calls.
    for (let attempt = 0; attempt < 60 && !sawTooMany; attempt += 1) {
      const response = await request('/api/auth/me', { token: reader.token, ip: uniqueIp() });
      sawTooMany = response.status === 429;
      if (!sawTooMany) {
        expect(response.status).toBe(200);
      }
    }

    expect(sawTooMany).toBe(true);
  });
});

describe('writing after the reveal (L5)', () => {
  it('refuses new quotes once the group has opened', async () => {
    const alice = await registerUser('Alice');
    const group = await createGroup(alice, 'Too late', nextYear);
    await unlockGroup(group.id);

    const response = await request(`/api/groups/${group.id}/quotes`, {
      method: 'POST',
      token: alice.token,
      body: { text: 'Written after reading everyone else', saidByMemberId: group.you.memberId },
    });

    expect(response.status).toBe(409);
    expect(response.body.error).toContain('no longer collecting');

    const stats = await request(`/api/groups/${group.id}/stats`, { token: alice.token });
    expect(stats.body.totalQuotes).toBe(0);
  });
});
