import { areQuotesVisible, buildQuiz, buildStats, getRevealAtIso, type GroupState } from './domain';

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });

const parseBody = async (request: Request) => {
  try {
    return (await request.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
};

export class GroupStore {
  constructor(private readonly ctx: DurableObjectState, private readonly _env: unknown) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const group = await this.ctx.storage.get<GroupState>('group');

    if (url.pathname === '/init' && request.method === 'POST') {
      if (group) {
        return jsonResponse({ error: 'Group already initialized' }, 409);
      }

      const body = await parseBody(request);
      if (!body || typeof body.id !== 'string' || typeof body.name !== 'string' || typeof body.revealYear !== 'number') {
        return jsonResponse({ error: 'Invalid payload' }, 400);
      }

      const nextGroup: GroupState = {
        id: body.id,
        name: body.name,
        revealYear: body.revealYear,
        createdAt: new Date().toISOString(),
        members: [],
        quotes: [],
      };

      await this.ctx.storage.put('group', nextGroup);
      return jsonResponse({ group: nextGroup }, 201);
    }

    if (!group) {
      return jsonResponse({ error: 'Group not found' }, 404);
    }

    if (url.pathname === '/group' && request.method === 'GET') {
      return jsonResponse({ group });
    }

    if (url.pathname === '/members' && request.method === 'POST') {
      const body = await parseBody(request);
      if (!body || typeof body.name !== 'string' || body.name.trim().length === 0) {
        return jsonResponse({ error: 'Invalid member name' }, 400);
      }

      const member = {
        id: crypto.randomUUID(),
        name: body.name.trim(),
      };

      group.members.push(member);
      await this.ctx.storage.put('group', group);
      return jsonResponse({ member }, 201);
    }

    if (url.pathname === '/quotes' && request.method === 'POST') {
      const body = await parseBody(request);
      const involvedMemberIds = Array.isArray(body?.involvedMemberIds)
        ? body.involvedMemberIds.filter((memberId: unknown): memberId is string => typeof memberId === 'string')
        : [];

      if (
        !body ||
        typeof body.text !== 'string' ||
        typeof body.saidByMemberId !== 'string' ||
        typeof body.recordedByMemberId !== 'string' ||
        body.text.trim().length === 0
      ) {
        return jsonResponse({ error: 'Invalid quote payload' }, 400);
      }

      const memberIds = new Set(group.members.map((member) => member.id));
      if (!memberIds.has(body.saidByMemberId) || !memberIds.has(body.recordedByMemberId)) {
        return jsonResponse({ error: 'Unknown members in quote payload' }, 400);
      }

      const unknownInvolvedMember = involvedMemberIds.some((memberId) => !memberIds.has(memberId));
      if (unknownInvolvedMember) {
        return jsonResponse({ error: 'Unknown involved member in quote payload' }, 400);
      }

      const quote = {
        id: crypto.randomUUID(),
        text: body.text.trim(),
        saidByMemberId: body.saidByMemberId,
        recordedByMemberId: body.recordedByMemberId,
        involvedMemberIds,
      };

      group.quotes.push(quote);
      await this.ctx.storage.put('group', group);
      return jsonResponse({ quote }, 201);
    }

    if (url.pathname === '/quotes' && request.method === 'GET') {
      if (!areQuotesVisible(group.revealYear)) {
        return jsonResponse(
          {
            error: 'Quotes are locked until end of year',
            revealAt: getRevealAtIso(group.revealYear),
          },
          423,
        );
      }

      return jsonResponse({ quotes: group.quotes });
    }

    if (url.pathname === '/quiz' && request.method === 'GET') {
      if (!areQuotesVisible(group.revealYear)) {
        return jsonResponse(
          {
            error: 'Quiz is locked until end of year',
            revealAt: getRevealAtIso(group.revealYear),
          },
          423,
        );
      }

      return jsonResponse({ questions: buildQuiz(group) });
    }

    if (url.pathname === '/stats' && request.method === 'GET') {
      return jsonResponse(buildStats(group));
    }

    return jsonResponse({ error: 'Not found' }, 404);
  }
}
