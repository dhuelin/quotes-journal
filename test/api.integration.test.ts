import { describe, expect, it } from 'vitest';
import { SELF } from 'cloudflare:test';
import { LIMITS } from '../src/domain';
import { createGroup, registerUser, request, unlockGroup, uniqueIp } from './helpers';

const nextYear = new Date().getUTCFullYear();

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
  const invite = async (owner: { token: string }, groupId: string) => {
    const response = await request(`/api/groups/${groupId}/invite`, { token: owner.token });
    expect(response.status).toBe(200);
    return response.body as { inviteCode: string; inviteUrl: string };
  };

  it('lets an invited user join and see the group', async () => {
    const alice = await registerUser('Alice');
    const bob = await registerUser('Bob');
    const group = await createGroup(alice, 'Invite crew', nextYear);

    const { inviteCode, inviteUrl } = await invite(alice, group.id);
    expect(inviteUrl).toContain('/join?invite=');

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
