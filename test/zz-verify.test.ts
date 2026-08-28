import { describe, it } from 'vitest';
import { SELF, env, runInDurableObject } from 'cloudflare:test';
import { request, registerUser, createGroup, uniqueIp } from './helpers';
import type { GroupState } from '../src/domain';
import type { UserRecord } from '../src/user-store';

const reg = (displayName: string, email: string, pw = 'correct horse battery staple', ip?: string) =>
  request('/api/auth/register', { method: 'POST', ip, body: { displayName, email, password: pw } });

describe('verify', () => {
  it('V-H1: guest-slot hijack', async () => {
    const alice = await registerUser('Alice');
    const group = await createGroup(alice, 'Claim');
    const guest = await request(`/api/groups/${group.id}/members`, { method: 'POST', token: alice.token, body: { name: 'Bob The Guest' } });
    const inv = await request(`/api/groups/${group.id}/invite`, { token: alice.token });
    const mal = await reg('  bob the guest  ', `mal${Date.now()}@example.com`);
    const join = await request('/api/invites/accept', { method: 'POST', token: mal.body.token, body: { inviteCode: inv.body.inviteCode } });
    console.log('V-H1 guest id', guest.body.member.id, '| hijack join ->', join.status, JSON.stringify(join.body));
  });

  it('V-H2: rotating cf-connecting-ip against one account', async () => {
    const victimEmail = `victim${Date.now()}@example.com`;
    await reg('Victim', victimEmail, 'the real password here');
    let allowed = 0, blocked = 0; const retry: number[] = [];
    for (let i = 0; i < 20; i++) {
      const r = await request('/api/auth/login', { method: 'POST', ip: `203.0.113.${i}`, body: { email: victimEmail, password: 'wrong guess ' + i } });
      if (r.status === 429) blocked++; else allowed++;
    }
    console.log('V-H2 rotating-IP guesses: allowed', allowed, 'blocked', blocked);
    const good = await request('/api/auth/login', { method: 'POST', ip: '9.9.9.9', body: { email: victimEmail, password: 'the real password here' } });
    console.log('V-H2 victim own correct-password login ->', good.status, JSON.stringify(good.body));
  });

  it('V-H2b: retry-after distinguishes the two buckets', async () => {
    const ip = '203.0.113.200';
    const hdrs: string[] = [];
    for (let i = 0; i < 14; i++) {
      const r = await SELF.fetch('https://example.com/api/auth/login', {
        method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip },
        body: JSON.stringify({ email: `distinct${i}@example.com`, password: 'wrong password here' }),
      });
      if (r.status === 429) hdrs.push('IP-bucket retry-after=' + r.headers.get('retry-after'));
    }
    const email = `acct${Date.now()}@example.com`;
    for (let i = 0; i < 8; i++) {
      const r = await SELF.fetch('https://example.com/api/auth/login', {
        method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': `203.0.114.${i}` },
        body: JSON.stringify({ email, password: 'wrong password here' }),
      });
      if (r.status === 429) hdrs.push('ACCOUNT-bucket retry-after=' + r.headers.get('retry-after') + ' body=' + (await r.text()));
    }
    console.log('V-H2b', JSON.stringify([...new Set(hdrs)]));
  });

  it('V-M1: iterations config + rehash on login', async () => {
    const email = `kdf${Date.now()}@example.com`;
    await reg('Kdf', email, 'the real password here');
    const stub = env.USERS.get(env.USERS.idFromName(email));
    await runInDurableObject(stub, async (_i, s) => {
      const u = (await s.storage.get<UserRecord>('user'))!;
      console.log('V-M1 stored hash prefix after register:', u.passwordHash.split('$').slice(0, 2).join('$'));
      // simulate a legacy account hashed at a lower round count
      u.passwordHash = u.passwordHash.replace(/^pbkdf2\$\d+\$/, 'pbkdf2$1000$');
      await s.storage.put('user', u);
    });
    const bad = await request('/api/auth/login', { method: 'POST', body: { email, password: 'the real password here' } });
    console.log('V-M1 login against a tampered 1000-round hash ->', bad.status);
  });

  it('V-M2: byte budget', async () => {
    const alice = await registerUser('Alice');
    const group = await createGroup(alice, 'Budget');
    const stub = env.GROUPS.get(env.GROUPS.idFromName(group.id));
    // fill to just under the budget with worst-case (3-byte UTF-8) quotes
    const ids = [group.you.memberId];
    let n = 0, bytes = 0;
    await runInDurableObject(stub, async (_i, s) => {
      const g = (await s.storage.get<GroupState>('group'))!;
      const enc = new TextEncoder();
      while (true) {
        const q = { id: crypto.randomUUID(), text: '日'.repeat(500), saidByMemberId: ids[0],
          recordedByMemberId: ids[0], involvedMemberIds: [], createdAt: new Date().toISOString() };
        const next = enc.encode(JSON.stringify(g)).length + enc.encode(JSON.stringify(q)).length + 1;
        if (next > 1_600_000) break;
        g.quotes.push(q as any); n++;
      }
      bytes = enc.encode(JSON.stringify(g)).length;
      await s.storage.put('group', g);
    });
    console.log('V-M2 seeded', n, 'worst-case quotes,', bytes, 'bytes; storage.put SUCCEEDED');
    const add = await request(`/api/groups/${group.id}/quotes`, {
      method: 'POST', token: alice.token, body: { text: '日'.repeat(500), saidByMemberId: group.you.memberId, involvedMemberIds: [] } });
    console.log('V-M2 one more quote ->', add.status, JSON.stringify(add.body));
    const m = await request(`/api/groups/${group.id}/members`, { method: 'POST', token: alice.token, body: { name: 'Late Guest' } });
    const rot = await request(`/api/groups/${group.id}/invite/rotate`, { method: 'POST', token: alice.token, body: {} });
    const bob = await registerUser('Bob');
    const inv = await request(`/api/groups/${group.id}/invite`, { token: alice.token });
    const j = await request('/api/invites/accept', { method: 'POST', token: bob.token, body: { inviteCode: inv.body.inviteCode } });
    console.log('V-M2 still writable: addMember', m.status, '| rotate', rot.status, '| join', j.status);
  });

  it('V-M3: duplicate display name on join', async () => {
    const alice = await registerUser('Alice');
    const group = await createGroup(alice, 'Dup');
    const inv = await request(`/api/groups/${group.id}/invite`, { token: alice.token });
    const fake = await reg('Alice', `fake${Date.now()}@example.com`);
    const j = await request('/api/invites/accept', { method: 'POST', token: fake.body.token, body: { inviteCode: inv.body.inviteCode } });
    console.log('V-M3 join as duplicate "Alice" ->', j.status, JSON.stringify(j.body));
  });

  it('V-M4: bulk enumeration of MANY addresses with a rotating IP', async () => {
    const taken = `taken${Date.now()}@example.com`;
    await reg('Taken', taken);
    let hits = 0, misses = 0, limited = 0;
    for (let i = 0; i < 12; i++) {
      const target = i % 2 === 0 ? taken : `free${Date.now()}-${i}@example.com`;
      const r = await reg('Probe', target, 'a long enough password', `198.18.0.${i}`);
      if (r.status === 429) limited++;
      else if (r.status === 409) hits++;
      else if (r.status === 201) misses++;
    }
    console.log('V-M4 12 probes across distinct addresses, rotating IP: 409(taken)=', hits, '201(free)=', misses, '429=', limited);
  });

  it('V-M5: invite expiry', async () => {
    const alice = await registerUser('Alice');
    const group = await createGroup(alice, 'Exp');
    const inv = await request(`/api/groups/${group.id}/invite`, { token: alice.token });
    const code: string = inv.body.inviteCode;
    console.log('V-M5 payload:', atob(code.split('.')[0].replace(/-/g, '+').replace(/_/g, '/')));
    console.log('V-M5 response fields:', JSON.stringify(Object.keys(inv.body)));
    const { readInviteCode, createInviteCode } = await import('../src/auth');
    const secret = (env as any).AUTH_SECRET;
    const future = new Date(Date.now() + 8 * 24 * 3600 * 1000);
    console.log('V-M5 read at now+8d ->', JSON.stringify(await readInviteCode(secret, code, future)));
    // forge a longer expiry
    const raw = atob(code.split('.')[0].replace(/-/g, '+').replace(/_/g, '/'));
    const parts = raw.split('.');
    const forgedBody = parts[0] + '.' + parts[1] + '.' + (Number(parts[2]) + 99999999);
    const b64 = btoa(forgedBody).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
    console.log('V-M5 forged expiry ->', JSON.stringify(await readInviteCode(secret, b64 + '.' + code.split('.')[1], future)));
    const stale = await createInviteCode(secret, group.id, 1, new Date(Date.now() - 8 * 24 * 3600 * 1000));
    const bob = await registerUser('Bob');
    const r = await request('/api/invites/accept', { method: 'POST', token: bob.token, body: { inviteCode: stale } });
    console.log('V-M5 expired code over the API ->', r.status, JSON.stringify(r.body));
  });

  it('V-L1: CSP + headers + nonce', async () => {
    const a = await SELF.fetch('https://example.com/app');
    const b = await SELF.fetch('https://example.com/app');
    const ha = Object.fromEntries([...a.headers]);
    console.log('V-L1 headers', JSON.stringify(ha, null, 0));
    const ta = await a.text(), tb = await b.text();
    const na = (ha['content-security-policy'].match(/nonce-([a-f0-9]+)/) || [])[1];
    const nb = ((b.headers.get('content-security-policy') || '').match(/nonce-([a-f0-9]+)/) || [])[1];
    console.log('V-L1 nonceA', na, 'nonceB', nb, 'differ?', na !== nb,
      '| scriptTagMatches?', ta.includes('<script nonce="' + na + '">'),
      '| styleTagMatches?', ta.includes('<style nonce="' + na + '">'),
      '| placeholderLeft?', ta.includes('__CSP_NONCE__'),
      '| crossNonceInB?', tb.includes(na));
  });

  it('V-L2/L3/L4/L5', async () => {
    const alice = await registerUser('Alice');
    const g = await createGroup(alice, 'Misc');
    const inv = await request(`/api/groups/${g.id}/invite`, { token: alice.token });
    console.log('V-L2 invite response keys ->', JSON.stringify(Object.keys(inv.body)));
    const rot = await request(`/api/groups/${g.id}/invite/rotate`, { method: 'POST', token: alice.token, body: {} });
    console.log('V-L2 rotate response keys ->', JSON.stringify(Object.keys(rot.body)));

    const bulk = await registerUser('Bulk');
    let created = 0, refused = 0;
    for (let i = 0; i < 55; i++) {
      const r = await request('/api/groups', { method: 'POST', token: bulk.token, body: { name: 'G' + i, revealYear: new Date().getUTCFullYear() } });
      if (r.status === 201) created++; else refused++;
    }
    const me = await request('/api/auth/me', { token: bulk.token });
    console.log('V-L3 created', created, 'refused', refused, 'listed', me.body.groups.length);

    const rl = await registerUser('Reader');
    const st = new Set<number>();
    for (let i = 0; i < 130; i++) st.add((await request('/api/auth/me', { token: rl.token })).status);
    console.log('V-L4 130 authenticated reads ->', [...st]);

    const pr = await registerUser('Post');
    const pg = await createGroup(pr, 'Post');
    const stub = env.GROUPS.get(env.GROUPS.idFromName(pg.id));
    await runInDurableObject(stub, async (_i, s) => {
      const gs = (await s.storage.get<GroupState>('group'))!; gs.revealYear = 2000; await s.storage.put('group', gs);
    });
    const add = await request(`/api/groups/${pg.id}/quotes`, { method: 'POST', token: pr.token, body: { text: 'after the reveal', saidByMemberId: pg.you.memberId } });
    console.log('V-L5 quote after reveal ->', add.status, JSON.stringify(add.body));
  });

  it('V-NEW: name squatting / guest dead end', async () => {
    const alice = await registerUser('Alice');
    const group = await createGroup(alice, 'Squat');
    await request(`/api/groups/${group.id}/members`, { method: 'POST', token: alice.token, body: { name: 'Bob' } });
    const inv = await request(`/api/groups/${group.id}/invite`, { token: alice.token });
    const realBob = await reg('Bob', `realbob${Date.now()}@example.com`);
    const j = await request('/api/invites/accept', { method: 'POST', token: realBob.body.token, body: { inviteCode: inv.body.inviteCode } });
    console.log('V-NEW real Bob joining after a guest "Bob" exists ->', j.status, JSON.stringify(j.body));

    // any member (not just owner) can pre-squat names
    const carol = await reg('Carol', `carol${Date.now()}@example.com`);
    await request('/api/invites/accept', { method: 'POST', token: carol.body.token, body: { inviteCode: inv.body.inviteCode } });
    const squat = await request(`/api/groups/${group.id}/members`, { method: 'POST', token: carol.body.token, body: { name: 'Dave' } });
    console.log('V-NEW non-owner member squats the name "Dave" ->', squat.status);
    const realDave = await reg('Dave', `dave${Date.now()}@example.com`);
    const jd = await request('/api/invites/accept', { method: 'POST', token: realDave.body.token, body: { inviteCode: inv.body.inviteCode } });
    console.log('V-NEW real Dave ->', jd.status, JSON.stringify(jd.body));
  });
});
