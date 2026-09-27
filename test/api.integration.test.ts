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
import {
  createGroup,
  fakeImage,
  rawRequest,
  registerUser,
  request,
  unlockGroup,
  uniqueIp,
  type TestUser,
} from './helpers';

const nextYear = new Date().getUTCFullYear();

/** Matches the AUTH_SECRET the workers pool binds in vitest.config.ts. */
const TEST_SECRET = 'test-secret-not-used-in-production';

const inviteCodeFor = async (owner: TestUser, groupId: string): Promise<string> => {
  const response = await request(`/api/groups/${groupId}/invite`, { token: owner.token });
  expect(response.status).toBe(200);
  return response.body.inviteCode as string;
};

/** Walks someone through a real invite so the membership checks are exercised. */
const joinGroup = async (owner: TestUser, joiner: TestUser, groupId: string): Promise<void> => {
  const inviteCode = await inviteCodeFor(owner, groupId);
  const response = await request('/api/invites/accept', {
    method: 'POST',
    token: joiner.token,
    body: { inviteCode },
  });
  expect(response.status).toBe(201);
};

/** The serialised size of what is actually in storage for a group. */
const storedGroupSize = async (groupId: string): Promise<number> =>
  runInDurableObject(env.GROUPS.get(env.GROUPS.idFromName(groupId)), async (_instance, state) =>
    groupByteSize((await state.storage.get<GroupState>('group')) as GroupState),
  );

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
    expect(quiz.body.questions[0].options).toHaveLength(2);
    // The reveal opens the questions, not the answers: those stay on the server
    // so that a quiz score means something. Rounds are played through
    // /quiz/start and /quiz/answer.
    // Cleo's id is in there — she is an answer option, as every member is.
    // What must not be there is anything saying which option is right.
    expect(quiz.body.questions[0].answerMemberId).toBeUndefined();
    expect(JSON.stringify(quiz.body)).not.toContain('answerMemberId');
    expect(JSON.stringify(quiz.body)).not.toContain('saidByMemberId');

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
  it('locks the app shell down and names the inline script and style by hash', async () => {
    const response = await SELF.fetch('https://example.com/app');
    const csp = response.headers.get('content-security-policy') ?? '';

    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('x-frame-options')).toBe('DENY');
    expect(response.headers.get('strict-transport-security')).toContain('max-age=');

    for (const directive of [
      "default-src 'none'",
      "connect-src 'self'",
      // blob: is the preview and the revealed picture, both created from bytes
      // this origin already holds; no remote image source is allowed.
      "img-src 'self' data: blob:",
      "manifest-src 'self'",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
    ]) {
      expect(csp, directive).toContain(directive);
    }
    expect(csp).not.toContain("'unsafe-inline'");
    expect(csp).not.toContain('nonce-');

    const shell = await response.text();
    expect(shell).toContain('<script>');
    expect(shell).toContain('<style>');
    expect(shell).not.toContain('__CSP_NONCE__');
  });

  it('serves a byte-identical shell every time, so it can be cached and opened offline', async () => {
    const first = await SELF.fetch('https://example.com/app');
    const second = await SELF.fetch('https://example.com/join');

    // This is the whole reason the policy moved off nonces. A nonce is fresh per
    // response, which makes every copy of the document unique — and a document
    // that cannot be cached cannot be opened without a connection.
    expect(first.headers.get('content-security-policy')).toBe(second.headers.get('content-security-policy'));
    expect(await first.text()).toBe(await second.text());
  });

  it('refuses to authorise a script the policy has not hashed', async () => {
    const response = await SELF.fetch('https://example.com/app');
    const csp = response.headers.get('content-security-policy') ?? '';
    const hash = /script-src '(sha256-[A-Za-z0-9+/=]+)'/.exec(csp)?.[1];

    expect(hash).toBeTruthy();

    // The hash has to be of the script actually served, or the app is dead on
    // arrival in a way no HTTP-level assertion would notice.
    const shell = await response.text();
    const script = shell.slice(shell.indexOf('<script>') + '<script>'.length, shell.lastIndexOf('</script>'));
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(script));
    const computed = `sha256-${btoa(String.fromCharCode(...new Uint8Array(digest)))}`;

    expect(computed).toBe(hash);
  });
});

describe('the service worker (L7)', () => {
  it('caches the shell and keeps every API response out of the cache', async () => {
    const response = await SELF.fetch('https://example.com/sw.js');
    const script = await response.text();

    expect(response.status).toBe(200);
    expect(script).toContain("addEventListener('fetch'");
    expect(script).toContain("caches.open");

    // The one rule that matters. Quotes, pictures and the account are read with
    // a bearer token; a copy in Cache Storage would outlive signing out, and for
    // a group still under its reveal lock it would be readable early.
    expect(script).toContain("url.pathname.startsWith('/api/')");
  });

  it('names its cache after the client, so a deploy reaches an installed app', async () => {
    const script = await (await SELF.fetch('https://example.com/sw.js')).text();
    const csp = (await SELF.fetch('https://example.com/app')).headers.get('content-security-policy') ?? '';
    const version = /quotes-journal-([A-Za-z0-9]+)/.exec(script)?.[1];

    expect(version).toBeTruthy();
    // Derived from the hashes of the client itself: change the client and this
    // changes, which is what makes a browser install the new worker at all.
    expect(csp.replace(/[^A-Za-z0-9]/g, '')).toContain(version as string);
  });

  it('is served uncached, or a stale worker could never be replaced', async () => {
    const response = await SELF.fetch('https://example.com/sw.js');

    expect(response.headers.get('cache-control')).toContain('no-cache');
  });
});

describe('pictures attached to quotes (L6)', () => {
  const addQuote = async (author: TestUser, groupId: string, saidByMemberId: string, text = 'Look at this') => {
    const response = await request(`/api/groups/${groupId}/quotes`, {
      method: 'POST',
      token: author.token,
      body: { text, saidByMemberId },
    });
    expect(response.status).toBe(201);
    return response.body.quote.id as string;
  };

  const attach = (author: TestUser, groupId: string, quoteId: string, bytes: Uint8Array) =>
    rawRequest(`/api/groups/${groupId}/quotes/${quoteId}/image`, {
      method: 'POST',
      token: author.token,
      contentType: 'image/jpeg',
      body: bytes,
    });

  it('keeps a picture sealed until the reveal, even from the person who uploaded it', async () => {
    const alice = await registerUser('Alice');
    const group = await createGroup(alice, 'Sealed pictures', nextYear);
    const quoteId = await addQuote(alice, group.id, group.you.memberId);

    expect((await attach(alice, group.id, quoteId, fakeImage('jpeg'))).status).toBe(201);

    const locked = await rawRequest(`/api/groups/${group.id}/quotes/${quoteId}/image`, { token: alice.token });
    expect(locked.status).toBe(423);
    expect((await locked.json<{ revealAt: string }>()).revealAt).toBeTruthy();
  });

  it('serves the picture after the reveal, with the type its bytes actually are', async () => {
    const alice = await registerUser('Alice');
    const group = await createGroup(alice, 'Opened pictures', nextYear);
    const quoteId = await addQuote(alice, group.id, group.you.memberId);

    // Uploaded claiming to be a JPEG; the bytes say PNG, and the bytes win.
    const png = fakeImage('png', 128);
    const upload = await rawRequest(`/api/groups/${group.id}/quotes/${quoteId}/image`, {
      method: 'POST',
      token: alice.token,
      contentType: 'image/jpeg',
      body: png,
    });
    expect(upload.status).toBe(201);

    await unlockGroup(group.id);

    const image = await rawRequest(`/api/groups/${group.id}/quotes/${quoteId}/image`, { token: alice.token });
    expect(image.status).toBe(200);
    expect(image.headers.get('content-type')).toBe('image/png');
    expect(image.headers.get('x-content-type-options')).toBe('nosniff');
    // A picture is private to the group, so no shared cache may keep a copy.
    expect(image.headers.get('cache-control')).toContain('no-store');
    expect(new Uint8Array(await image.arrayBuffer())).toEqual(png);

    const quotes = await request(`/api/groups/${group.id}/quotes`, { token: alice.token });
    expect(quotes.body.quotes[0].image).toMatchObject({ contentType: 'image/png', bytes: 128 });
  });

  it('refuses anything that is not a picture, whatever the header says', async () => {
    const alice = await registerUser('Alice');
    const group = await createGroup(alice, 'Not a picture', nextYear);
    const quoteId = await addQuote(alice, group.id, group.you.memberId);

    // An SVG is an image to a browser and a script host to an attacker; it has
    // no magic number in the allow-list, so it never reaches storage.
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    const response = await attach(alice, group.id, quoteId, svg);

    expect(response.status).toBe(415);
    expect((await response.json<{ error: string }>()).error).toContain('JPEG, PNG and WebP');
  });

  it('refuses a picture over the size cap', async () => {
    const alice = await registerUser('Alice');
    const group = await createGroup(alice, 'Too big', nextYear);
    const quoteId = await addQuote(alice, group.id, group.you.memberId);

    const response = await attach(alice, group.id, quoteId, fakeImage('jpeg', LIMITS.quoteImageBytes + 1));

    expect(response.status).toBe(413);
  });

  it('lets only the recorder attach or remove a picture', async () => {
    const alice = await registerUser('Alice');
    const bob = await registerUser('Bob');
    const group = await createGroup(alice, 'Whose quote', nextYear);
    await joinGroup(alice, bob, group.id);
    const quoteId = await addQuote(alice, group.id, group.you.memberId);

    expect((await attach(bob, group.id, quoteId, fakeImage('jpeg'))).status).toBe(403);

    const removedByBob = await request(`/api/groups/${group.id}/quotes/${quoteId}/image/remove`, {
      method: 'POST',
      token: bob.token,
      body: {},
    });
    expect(removedByBob.status).toBe(403);
  });

  it('lets the recorder replace a picture and take it away again', async () => {
    const alice = await registerUser('Alice');
    const group = await createGroup(alice, 'Wrong photo', nextYear);
    const quoteId = await addQuote(alice, group.id, group.you.memberId);

    expect((await attach(alice, group.id, quoteId, fakeImage('jpeg', 100))).status).toBe(201);
    const replaced = await attach(alice, group.id, quoteId, fakeImage('webp', 200));
    expect(replaced.status).toBe(201);
    expect((await replaced.json<{ image: { bytes: number } }>()).image.bytes).toBe(200);

    const removed = await request(`/api/groups/${group.id}/quotes/${quoteId}/image/remove`, {
      method: 'POST',
      token: alice.token,
      body: {},
    });
    expect(removed.status).toBe(200);

    await unlockGroup(group.id);
    const gone = await rawRequest(`/api/groups/${group.id}/quotes/${quoteId}/image`, { token: alice.token });
    expect(gone.status).toBe(404);

    const quotes = await request(`/api/groups/${group.id}/quotes`, { token: alice.token });
    expect(quotes.body.quotes[0].image).toBeUndefined();
  });

  it('hides a picture from someone outside the group behind the same 404 as the group', async () => {
    const alice = await registerUser('Alice');
    const stranger = await registerUser('Mallory');
    const group = await createGroup(alice, 'Private pictures', nextYear);
    const quoteId = await addQuote(alice, group.id, group.you.memberId);
    await attach(alice, group.id, quoteId, fakeImage('jpeg'));
    await unlockGroup(group.id);

    const response = await rawRequest(`/api/groups/${group.id}/quotes/${quoteId}/image`, { token: stranger.token });

    expect(response.status).toBe(404);
    expect((await response.json<{ error: string }>()).error).toBe('Group not found');
  });

  it('stops accepting pictures once the group has opened', async () => {
    const alice = await registerUser('Alice');
    const group = await createGroup(alice, 'Late picture', nextYear);
    const quoteId = await addQuote(alice, group.id, group.you.memberId);
    await unlockGroup(group.id);

    const response = await attach(alice, group.id, quoteId, fakeImage('jpeg'));

    expect(response.status).toBe(409);
    expect((await response.json<{ error: string }>()).error).toContain('no longer collecting');
  });

  it('keeps the picture bytes out of the stored group value', async () => {
    const alice = await registerUser('Alice');
    const group = await createGroup(alice, 'Blob budget', nextYear);
    const quoteId = await addQuote(alice, group.id, group.you.memberId);
    const before = await storedGroupSize(group.id);

    await attach(alice, group.id, quoteId, fakeImage('jpeg', 500_000));

    // Only the metadata lands in the group value. Were the bytes in there, the
    // group would be a few writes from the ceiling that breaks every later one.
    const after = await storedGroupSize(group.id);
    expect(after - before).toBeLessThan(200);
  });
});

/**
 * The quiz is scored on the server, and these are the reasons that was worth
 * doing. Every test here is a way the score could otherwise have been faked.
 */
describe('the quiz round (L8)', () => {
  const playableGroup = async () => {
    const alice = await registerUser('Alice');
    const group = await createGroup(alice, 'Quiz night', nextYear);

    // Three members, because with two every question is a coin flip.
    for (const name of ['Bob', 'Cleo']) {
      const added = await request(`/api/groups/${group.id}/members`, {
        method: 'POST',
        token: alice.token,
        body: { name },
      });
      expect(added.status).toBe(201);
    }

    const fresh = await request(`/api/groups/${group.id}`, { token: alice.token });
    const members = fresh.body.group.members as { id: string; name: string }[];

    for (const member of members) {
      const saved = await request(`/api/groups/${group.id}/quotes`, {
        method: 'POST',
        token: alice.token,
        body: { text: `Something ${member.name} said`, saidByMemberId: member.id },
      });
      expect(saved.status).toBe(201);
    }

    await unlockGroup(group.id);
    return { alice, group, members };
  };

  /** Everything the question shows, which is what the test reads the answer from. */
  const asked = (question: { lines: { text: string }[] }): string =>
    question.lines.map((line) => line.text).join(' ');

  const start = (player: TestUser, groupId: string) =>
    request(`/api/groups/${groupId}/quiz/start`, { method: 'POST', token: player.token, body: {} });

  const answer = (player: TestUser, groupId: string, quoteId: string, memberId: string | null) =>
    request(`/api/groups/${groupId}/quiz/answer`, {
      method: 'POST',
      token: player.token,
      body: { quoteId, memberId },
    });

  it('never sends the answer with the question', async () => {
    const { alice, group } = await playableGroup();

    const started = await start(alice, group.id);
    expect(started.status).toBe(201);
    expect(JSON.stringify(started.body.question)).not.toContain('answerMemberId');
    expect(JSON.stringify(started.body.question)).not.toContain('saidByMemberId');

    // The read-only question list is the same: questions, never answers.
    const listed = await request(`/api/groups/${group.id}/quiz`, { token: alice.token });
    expect(JSON.stringify(listed.body)).not.toContain('answerMemberId');
  });

  it('scores a correct answer and reveals the answer only afterwards', async () => {
    const { alice, group, members } = await playableGroup();
    const started = await start(alice, group.id);
    const question = started.body.question;

    // The quote text names who said it, which is how the test knows the answer
    // without the server ever having told the client.
    const expected = members.find((member) => asked(question).includes(member.name))!;
    const response = await answer(alice, group.id, question.quoteId, expected.id);

    expect(response.status).toBe(200);
    expect(response.body.correct).toBe(true);
    expect(response.body.answerMemberId).toBe(expected.id);
    expect(response.body.points).toBeGreaterThan(0);
    expect(response.body.score).toBe(response.body.points);
  });

  it('scores nothing for a wrong answer and nothing for no answer at all', async () => {
    const { alice, group, members } = await playableGroup();

    const started = await start(alice, group.id);
    const wrong = members.find((member) => !asked(started.body.question).includes(member.name))!;
    const missed = await answer(alice, group.id, started.body.question.quoteId, wrong.id);
    expect(missed.body.correct).toBe(false);
    expect(missed.body.points).toBe(0);

    // A question left to expire is a real answer, worth nothing.
    const expired = await answer(alice, group.id, missed.body.question.quoteId, null);
    expect(expired.status).toBe(200);
    expect(expired.body.correct).toBe(false);
    expect(expired.body.points).toBe(0);
  });

  it('refuses an answer to a question the round has already moved past', async () => {
    const { alice, group, members } = await playableGroup();
    const started = await start(alice, group.id);
    const first = started.body.question;
    const right = members.find((member) => asked(first).includes(member.name))!;

    const scored = await answer(alice, group.id, first.quoteId, right.id);
    expect(scored.body.correct).toBe(true);

    // Replaying the same question would otherwise bank the same points again.
    const replay = await answer(alice, group.id, first.quoteId, right.id);
    expect(replay.status).toBe(409);
    expect(replay.body.error).toContain('not the question you are on');
  });

  it('finishes after every question and reports the round', async () => {
    const { alice, group, members } = await playableGroup();
    let current = (await start(alice, group.id)).body.question;
    let rounds = 0;
    let last: any = null;

    while (current) {
      const right = members.find((member) => asked(current).includes(member.name))!;
      last = await answer(alice, group.id, current.quoteId, right.id);
      current = last.body.question;
      rounds += 1;
    }

    expect(rounds).toBe(3);
    expect(last.body.finished).toBe(true);
    expect(last.body.summary).toMatchObject({ correct: 3, total: 3 });
    expect(last.body.summary.score).toBeGreaterThan(0);

    const over = await answer(alice, group.id, 'anything', null);
    expect(over.status).toBe(409);
  });

  it('keeps a member’s best round, so starting another can never cost them one', async () => {
    const { alice, group, members } = await playableGroup();

    const playAll = async (correctly: boolean) => {
      let current = (await start(alice, group.id)).body.question;
      let final: any = null;
      while (current) {
        const pick = correctly
          ? members.find((member) => asked(current).includes(member.name))!.id
          : null;
        final = await answer(alice, group.id, current.quoteId, pick);
        current = final.body.question;
      }
      return final.body.summary.score as number;
    };

    const good = await playAll(true);
    const bad = await playAll(false);
    expect(good).toBeGreaterThan(0);
    expect(bad).toBe(0);

    // Restarting is free in a party game; it must not overwrite a good round.
    const scores = await request(`/api/groups/${group.id}/quiz/scores`, { token: alice.token });
    expect(scores.body.leaderboard[0]).toMatchObject({ name: 'Alice', score: good });
  });

  it('refuses to start where every question would be a coin flip', async () => {
    const alice = await registerUser('Alice');
    const group = await createGroup(alice, 'Just us', nextYear);
    await request(`/api/groups/${group.id}/quotes`, {
      method: 'POST',
      token: alice.token,
      body: { text: 'Alone in here', saidByMemberId: group.you.memberId },
    });
    await unlockGroup(group.id);

    const response = await start(alice, group.id);

    expect(response.status).toBe(409);
    expect(response.body.needsMembers).toBe(3);
  });

  it('stays locked with everything else until the reveal', async () => {
    const alice = await registerUser('Alice');
    const group = await createGroup(alice, 'Still sealed', nextYear);

    for (const path of ['/quiz/start', '/quiz/answer']) {
      const response = await request(`/api/groups/${group.id}${path}`, {
        method: 'POST',
        token: alice.token,
        body: {},
      });
      expect(response.status, path).toBe(423);
    }

    const scores = await request(`/api/groups/${group.id}/quiz/scores`, { token: alice.token });
    expect(scores.status).toBe(423);
  });

  it('hides the round from someone outside the group', async () => {
    const { group } = await playableGroup();
    const stranger = await registerUser('Mallory');

    const response = await start(stranger, group.id);

    expect(response.status).toBe(404);
    expect(response.body.error).toBe('Group not found');
  });
});

/**
 * A reveal date can be chosen, and can only ever be pushed later. The rule is
 * enforced in the group object rather than the UI, because a rule only the UI
 * knows is not a rule.
 */
describe('choosing and moving the reveal (L9)', () => {
  const inDays = (days: number): string => new Date(Date.now() + days * 86_400_000).toISOString();

  it('opens on the chosen instant instead of 1 January', async () => {
    const alice = await registerUser('Alice');
    const party = inDays(30);

    const created = await request('/api/groups', {
      method: 'POST',
      token: alice.token,
      body: { name: 'Christmas party', revealYear: nextYear, revealAt: party },
    });

    expect(created.status).toBe(201);
    expect(created.body.group.revealAt).toBe(party);
    expect(created.body.group.locked).toBe(true);
  });

  it('still defaults to 1 January when no date is given', async () => {
    const alice = await registerUser('Alice');
    const group = await createGroup(alice, 'The usual', nextYear);

    expect(group.revealAt).toBe(`${nextYear + 1}-01-01T00:00:00.000Z`);
  });

  it('refuses a date in the past or beyond ten years', async () => {
    const alice = await registerUser('Alice');

    for (const revealAt of [inDays(-1), inDays(365 * 11), 'not a date']) {
      const response = await request('/api/groups', {
        method: 'POST',
        token: alice.token,
        body: { name: 'Nope', revealYear: nextYear, revealAt },
      });
      expect(response.status, String(revealAt)).toBe(400);
    }
  });

  it('lets the owner postpone, and shows every member that it moved', async () => {
    const alice = await registerUser('Alice');
    const bob = await registerUser('Bob');
    const created = await request('/api/groups', {
      method: 'POST',
      token: alice.token,
      body: { name: 'Moved', revealYear: nextYear, revealAt: inDays(30) },
    });
    const group = created.body.group;
    await joinGroup(alice, bob, group.id);

    const later = inDays(60);
    const moved = await request(`/api/groups/${group.id}/reveal`, {
      method: 'POST',
      token: alice.token,
      body: { revealAt: later },
    });

    expect(moved.status).toBe(200);
    expect(moved.body.group.revealAt).toBe(later);

    // Bob sees both the new date and the fact that it was changed at all.
    const asBob = await request(`/api/groups/${group.id}`, { token: bob.token });
    expect(asBob.body.group.revealAt).toBe(later);
    expect(asBob.body.group.revealMovedAt).toBeTruthy();
  });

  it('refuses to pull the reveal forward, which is the whole promise', async () => {
    const alice = await registerUser('Alice');
    const created = await request('/api/groups', {
      method: 'POST',
      token: alice.token,
      body: { name: 'Impatient', revealYear: nextYear, revealAt: inDays(30) },
    });

    const response = await request(`/api/groups/${created.body.group.id}/reveal`, {
      method: 'POST',
      token: alice.token,
      body: { revealAt: inDays(2) },
    });

    expect(response.status).toBe(409);
    expect(response.body.error).toContain('only be moved later');

    const unchanged = await request(`/api/groups/${created.body.group.id}`, { token: alice.token });
    expect(unchanged.body.group.revealAt).toBe(created.body.group.revealAt);
  });

  it('lets nobody but the owner move it', async () => {
    const alice = await registerUser('Alice');
    const bob = await registerUser('Bob');
    const group = await createGroup(alice, 'Not yours', nextYear);
    await joinGroup(alice, bob, group.id);

    const response = await request(`/api/groups/${group.id}/reveal`, {
      method: 'POST',
      token: bob.token,
      body: { revealAt: inDays(400) },
    });

    expect(response.status).toBe(403);
  });

  it('refuses any change once the group has opened', async () => {
    const alice = await registerUser('Alice');
    const group = await createGroup(alice, 'Already read', nextYear);
    await unlockGroup(group.id);

    // Re-sealing would reopen collecting to someone who has read everything.
    const response = await request(`/api/groups/${group.id}/reveal`, {
      method: 'POST',
      token: alice.token,
      body: { revealAt: inDays(400) },
    });

    expect(response.status).toBe(409);
    expect(response.body.error).toContain('already opened');
  });

  it('keeps a group stored with only a year exactly where it was', async () => {
    const alice = await registerUser('Alice');
    const group = await createGroup(alice, 'Legacy', nextYear);

    // Strip the instant, as a group created before this feature would be.
    await runInDurableObject(env.GROUPS.get(env.GROUPS.idFromName(group.id)), async (_instance, state) => {
      const stored = (await state.storage.get<GroupState>('group')) as GroupState;
      delete stored.revealAt;
      await state.storage.put('group', stored);
    });

    const overview = await request(`/api/groups/${group.id}`, { token: alice.token });
    expect(overview.body.group.revealAt).toBe(`${nextYear + 1}-01-01T00:00:00.000Z`);
    expect(overview.body.group.locked).toBe(true);
  });
});

/** A quote with more than one speaker, and what the quiz does with one. */
describe('conversations (L10)', () => {
  const conversation = [
    { text: 'I am not lost.' },
    { text: 'You have been driving in circles for twenty minutes.' },
  ];

  const groupWithThree = async () => {
    const alice = await registerUser('Alice');
    const group = await createGroup(alice, 'Road trip', nextYear);
    for (const name of ['Bob', 'Cleo']) {
      await request(`/api/groups/${group.id}/members`, { method: 'POST', token: alice.token, body: { name } });
    }
    const fresh = await request(`/api/groups/${group.id}`, { token: alice.token });
    return { alice, group, members: fresh.body.group.members as { id: string; name: string }[] };
  };

  it('records an exchange and reads it back as one', async () => {
    const { alice, group, members } = await groupWithThree();
    const lines = conversation.map((line, index) => ({ ...line, saidByMemberId: members[index].id }));

    const saved = await request(`/api/groups/${group.id}/quotes`, {
      method: 'POST',
      token: alice.token,
      body: { lines },
    });
    expect(saved.status).toBe(201);

    await unlockGroup(group.id);
    const quotes = await request(`/api/groups/${group.id}/quotes`, { token: alice.token });

    expect(quotes.body.quotes[0].lines).toHaveLength(2);
    expect(quotes.body.quotes[0].lines[1].text).toContain('driving in circles');
    // The opening line is mirrored, so a client that knows nothing about
    // conversations still shows something correct rather than nothing.
    expect(quotes.body.quotes[0].text).toBe('I am not lost.');
    expect(quotes.body.quotes[0].saidByMemberId).toBe(members[0].id);
  });

  it('still accepts a single remark in the shape it always had', async () => {
    const { alice, group } = await groupWithThree();

    const saved = await request(`/api/groups/${group.id}/quotes`, {
      method: 'POST',
      token: alice.token,
      body: { text: 'Technically the cake is a salad', saidByMemberId: group.you.memberId },
    });
    expect(saved.status).toBe(201);

    await unlockGroup(group.id);
    const quotes = await request(`/api/groups/${group.id}/quotes`, { token: alice.token });

    // Stored as a remark, not as a one-line exchange: nothing already recorded
    // changes shape, and neither does anything recorded the old way now.
    expect(quotes.body.quotes[0].lines).toBeUndefined();
    expect(quotes.body.quotes[0].text).toBe('Technically the cake is a salad');
  });

  it('refuses a line whose speaker is not in the group, and an over-long one', async () => {
    const { alice, group, members } = await groupWithThree();

    const stranger = await request(`/api/groups/${group.id}/quotes`, {
      method: 'POST',
      token: alice.token,
      body: { lines: [{ saidByMemberId: 'someone-else', text: 'Hello' }] },
    });
    expect(stranger.status).toBe(400);

    const tooLong = await request(`/api/groups/${group.id}/quotes`, {
      method: 'POST',
      token: alice.token,
      body: {
        lines: [{ saidByMemberId: members[0].id, text: 'x'.repeat(LIMITS.quoteText + 1) }],
      },
    });
    expect(tooLong.status).toBe(400);

    const tooMany = await request(`/api/groups/${group.id}/quotes`, {
      method: 'POST',
      token: alice.token,
      body: {
        lines: Array.from({ length: LIMITS.quoteLines + 1 }, () => ({
          saidByMemberId: members[0].id,
          text: 'Again',
        })),
      },
    });
    expect(tooMany.status).toBe(400);
  });

  it('asks the quiz about one line, showing the rest with their speakers', async () => {
    const { alice, group, members } = await groupWithThree();
    await request(`/api/groups/${group.id}/quotes`, {
      method: 'POST',
      token: alice.token,
      body: { lines: conversation.map((line, index) => ({ ...line, saidByMemberId: members[index].id })) },
    });
    await unlockGroup(group.id);

    const started = await request(`/api/groups/${group.id}/quiz/start`, {
      method: 'POST',
      token: alice.token,
      body: {},
    });
    const question = started.body.question;

    expect(question.lines).toHaveLength(2);
    // Exactly one line is the question; the others are context, named.
    expect(question.lines.filter((line: { speaker: string | null }) => line.speaker === null)).toHaveLength(1);
    expect(question.lines[question.askedLine].speaker).toBeNull();
    expect(JSON.stringify(question)).not.toContain('saidByMemberId');

    // Both lines are asked about across the round, so a two-line exchange is
    // two questions rather than one.
    expect(question.total).toBe(2);
  });

  it('scores the asked line, not the first one', async () => {
    const { alice, group, members } = await groupWithThree();
    await request(`/api/groups/${group.id}/quotes`, {
      method: 'POST',
      token: alice.token,
      body: { lines: conversation.map((line, index) => ({ ...line, saidByMemberId: members[index].id })) },
    });
    await unlockGroup(group.id);

    const started = await request(`/api/groups/${group.id}/quiz/start`, {
      method: 'POST',
      token: alice.token,
      body: {},
    });
    const question = started.body.question;
    const speaker = members[question.askedLine];

    const response = await request(`/api/groups/${group.id}/quiz/answer`, {
      method: 'POST',
      token: alice.token,
      body: { quoteId: question.quoteId, memberId: speaker.id },
    });

    expect(response.body.correct).toBe(true);
    expect(response.body.answerMemberId).toBe(speaker.id);
  });

  it('counts an exchange once towards the quote cap, and its speakers each once', async () => {
    const { alice, group, members } = await groupWithThree();
    await request(`/api/groups/${group.id}/quotes`, {
      method: 'POST',
      token: alice.token,
      body: { lines: conversation.map((line, index) => ({ ...line, saidByMemberId: members[index].id })) },
    });
    await unlockGroup(group.id);

    const stats = await request(`/api/groups/${group.id}/stats`, { token: alice.token });

    expect(stats.body.totalQuotes).toBe(1);
    expect(stats.body.saidBy[members[0].id]).toBe(1);
    expect(stats.body.saidBy[members[1].id]).toBe(1);
  });
});

/** Account and group settings: the name, the group list, and the way out. */
describe('settings (L11)', () => {
  it('changes the display name and hands back a token that carries it', async () => {
    const alice = await registerUser('Alice');

    const renamed = await request('/api/account/display-name', {
      method: 'POST',
      token: alice.token,
      body: { displayName: 'Alicia' },
    });

    expect(renamed.status).toBe(200);
    expect(renamed.body.user.displayName).toBe('Alicia');
    expect(renamed.body.token).toBeTruthy();

    // The token names the creator of a group. Without a fresh one the new name
    // would not reach a group made straight afterwards.
    const group = await createGroup({ ...alice, token: renamed.body.token }, 'After the rename', nextYear);
    expect(group.members[0].name).toBe('Alicia');
  });

  it('leaves the member row behind, so quotes about someone who left still read', async () => {
    const alice = await registerUser('Alice');
    const bob = await registerUser('Bob');
    const group = await createGroup(alice, 'Leavers', nextYear);
    await joinGroup(alice, bob, group.id);

    const fresh = await request(`/api/groups/${group.id}`, { token: alice.token });
    const bobMember = (fresh.body.group.members as { id: string; name: string }[]).find((m) => m.name === 'Bob')!;

    await request(`/api/groups/${group.id}/quotes`, {
      method: 'POST',
      token: alice.token,
      body: { text: 'Something Bob said', saidByMemberId: bobMember.id },
    });

    const left = await request(`/api/groups/${group.id}/leave`, { method: 'POST', token: bob.token, body: {} });
    expect(left.status).toBe(200);

    // Access ends immediately, and the group is off his list.
    const denied = await request(`/api/groups/${group.id}`, { token: bob.token });
    expect(denied.status).toBe(404);
    const account = await request('/api/auth/me', { token: bob.token });
    expect(account.body.groups).toHaveLength(0);

    // The history does not develop a hole. Bob is still on the quote.
    await unlockGroup(group.id);
    const stats = await request(`/api/groups/${group.id}/stats`, { token: alice.token });
    expect(stats.body.leaderboard.find((entry: { name: string }) => entry.name === 'Bob')).toMatchObject({ said: 1 });

    const quotes = await request(`/api/groups/${group.id}/quotes`, { token: alice.token });
    expect(quotes.body.quotes[0].saidByMemberId).toBe(bobMember.id);
  });

  it('will not let the owner leave a group nobody could then manage', async () => {
    const alice = await registerUser('Alice');
    const group = await createGroup(alice, 'Ownerless', nextYear);

    const response = await request(`/api/groups/${group.id}/leave`, { method: 'POST', token: alice.token, body: {} });

    expect(response.status).toBe(409);
    expect(response.body.needsTransfer).toBe(true);
  });

  it('hands the group over, and then the old owner can leave', async () => {
    const alice = await registerUser('Alice');
    const bob = await registerUser('Bob');
    const group = await createGroup(alice, 'Handover', nextYear);
    await joinGroup(alice, bob, group.id);

    const fresh = await request(`/api/groups/${group.id}`, { token: alice.token });
    const bobMember = (fresh.body.group.members as { id: string; name: string }[]).find((m) => m.name === 'Bob')!;

    const handed = await request(`/api/groups/${group.id}/members/transfer`, {
      method: 'POST',
      token: alice.token,
      body: { memberId: bobMember.id },
    });
    expect(handed.status).toBe(200);
    // The outgoing owner stays a member: this is a handover, not an exit.
    expect(handed.body.group.you.role).toBe('member');

    const asBob = await request(`/api/groups/${group.id}`, { token: bob.token });
    expect(asBob.body.group.you.role).toBe('owner');

    const left = await request(`/api/groups/${group.id}/leave`, { method: 'POST', token: alice.token, body: {} });
    expect(left.status).toBe(200);
  });

  it('refuses to hand a group to a guest, who has no account to sign in with', async () => {
    const alice = await registerUser('Alice');
    const group = await createGroup(alice, 'No guests', nextYear);
    const guest = await request(`/api/groups/${group.id}/members`, {
      method: 'POST',
      token: alice.token,
      body: { name: 'Cleo' },
    });

    const response = await request(`/api/groups/${group.id}/members/transfer`, {
      method: 'POST',
      token: alice.token,
      body: { memberId: guest.body.member.id },
    });

    expect(response.status).toBe(409);
  });

  it('renames a group, and the stale cached name heals when a member opens it (#9)', async () => {
    const alice = await registerUser('Alice');
    const bob = await registerUser('Bob');
    const group = await createGroup(alice, 'Old name', nextYear);
    await joinGroup(alice, bob, group.id);

    const renamed = await request(`/api/groups/${group.id}/rename`, {
      method: 'POST',
      token: alice.token,
      body: { name: 'New name' },
    });
    expect(renamed.status).toBe(200);

    // The owner's own list is right straight away.
    const ownerList = await request('/api/auth/me', { token: alice.token });
    expect(ownerList.body.groups[0].name).toBe('New name');

    // Bob's is stale until he looks at the group, and then it is not.
    const staleList = await request('/api/auth/me', { token: bob.token });
    expect(staleList.body.groups[0].name).toBe('Old name');

    await request(`/api/groups/${group.id}`, { token: bob.token });

    const healed = await request('/api/auth/me', { token: bob.token });
    expect(healed.body.groups[0].name).toBe('New name');
  });

  it('lets nobody but the owner rename the group', async () => {
    const alice = await registerUser('Alice');
    const bob = await registerUser('Bob');
    const group = await createGroup(alice, 'Not yours', nextYear);
    await joinGroup(alice, bob, group.id);

    const response = await request(`/api/groups/${group.id}/rename`, {
      method: 'POST',
      token: bob.token,
      body: { name: 'Mine now' },
    });

    expect(response.status).toBe(403);
  });
});
