import { describe, expect, it } from 'vitest';
import { SELF } from 'cloudflare:test';

describe('quotes journal API', () => {
  it('serves web and app interfaces', async () => {
    const web = await SELF.fetch('https://example.com/');
    expect(web.status).toBe(200);
    expect(await web.text()).toContain('Quotes Journal (Web)');

    const app = await SELF.fetch('https://example.com/app');
    expect(app.status).toBe(200);
    expect(await app.text()).toContain('Quotes Journal (App Interface)');

    const manifest = await SELF.fetch('https://example.com/manifest.webmanifest');
    expect(manifest.status).toBe(200);
    expect(await manifest.json()).toMatchObject({ start_url: '/app', display: 'standalone' });

    const serviceWorker = await SELF.fetch('https://example.com/sw.js');
    expect(serviceWorker.status).toBe(200);
    expect(await serviceWorker.text()).toContain('self.addEventListener');
  });

  it('creates a group and enforces quote lock until year-end', async () => {
    const createGroupResponse = await SELF.fetch('https://example.com/api/groups', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Locked group', revealYear: 2999 }),
    });
    expect(createGroupResponse.status).toBe(201);
    const createGroupBody = (await createGroupResponse.json()) as { group: { id: string } };

    const quotesResponse = await SELF.fetch(`https://example.com/api/groups/${createGroupBody.group.id}/quotes`);
    expect(quotesResponse.status).toBe(423);
    const quotesBody = (await quotesResponse.json()) as { revealAt: string };
    expect(quotesBody.revealAt).toBe('3000-01-01T00:00:00.000Z');
  });

  it('creates members and quotes, then builds quiz and stats for unlocked groups', async () => {
    const createGroupResponse = await SELF.fetch('https://example.com/api/groups', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Unlocked group', revealYear: 2000 }),
    });
    const createGroupBody = (await createGroupResponse.json()) as { group: { id: string } };

    const addMember = async (name: string) => {
      const response = await SELF.fetch(`https://example.com/api/groups/${createGroupBody.group.id}/members`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      expect(response.status).toBe(201);
      return (await response.json()) as { member: { id: string } };
    };

    const alice = await addMember('Alice');
    const bob = await addMember('Bob');

    const quoteResponse = await SELF.fetch(`https://example.com/api/groups/${createGroupBody.group.id}/quotes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text: 'Best quote ever',
        saidByMemberId: alice.member.id,
        recordedByMemberId: bob.member.id,
        involvedMemberIds: [alice.member.id, bob.member.id],
      }),
    });
    expect(quoteResponse.status).toBe(201);

    const quizResponse = await SELF.fetch(`https://example.com/api/groups/${createGroupBody.group.id}/quiz`);
    expect(quizResponse.status).toBe(200);
    const quizBody = (await quizResponse.json()) as { questions: Array<{ answerMemberId: string }> };
    expect(quizBody.questions).toHaveLength(1);
    expect(quizBody.questions[0].answerMemberId).toBe(alice.member.id);

    const statsResponse = await SELF.fetch(`https://example.com/api/groups/${createGroupBody.group.id}/stats`);
    expect(statsResponse.status).toBe(200);
    const statsBody = (await statsResponse.json()) as {
      persistedBy: Record<string, number>;
      saidBy: Record<string, number>;
    };

    expect(statsBody.persistedBy[bob.member.id]).toBe(1);
    expect(statsBody.saidBy[alice.member.id]).toBe(1);
  });
});
