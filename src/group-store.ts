import {
  areQuotesVisible,
  exceedsGroupBudget,
  buildProgress,
  buildQuiz,
  buildStats,
  findMemberByUserId,
  getRevealAtIso,
  LIMITS,
  type GroupState,
  type Member,
} from './domain';
import { readJsonBody, validateMemberIdList, validateText } from './validation';

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });

const lockedResponse = (group: GroupState, subject: string): Response =>
  jsonResponse(
    {
      error: `${subject} stay locked until the year is over`,
      revealAt: getRevealAtIso(group.revealYear),
    },
    423,
  );

/** The caller identity the Worker attaches after verifying the session token. */
type Caller = {
  userId: string;
  displayName: string;
};

const readCaller = (request: Request): Caller | null => {
  const userId = request.headers.get('x-user-id');
  const displayName = request.headers.get('x-user-name');
  if (!userId || !displayName) {
    return null;
  }
  return { userId, displayName };
};

/** The UI identifies members by name alone, so names have to stay unambiguous. */
const hasMemberNamed = (group: GroupState, name: string): boolean =>
  group.members.some((member) => member.name.toLowerCase() === name.toLowerCase());

const publicMember = (member: Member, viewerMemberId: string) => ({
  id: member.id,
  name: member.name,
  role: member.role,
  isGuest: member.userId === null,
  isYou: member.id === viewerMemberId,
});

export class GroupStore {
  constructor(private readonly ctx: DurableObjectState, private readonly _env: unknown) {}

  async fetch(request: Request): Promise<Response> {
    // A group and all of its quotes live in one stored value, so a write that
    // outgrows the Durable Object value ceiling throws. Without this the runtime
    // answers with a plain-text 500 that no client can parse.
    try {
      return await this.route(request);
    } catch {
      return jsonResponse({ error: 'The group could not be updated, please try again later' }, 500);
    }
  }

  private async route(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const caller = readCaller(request);
    if (!caller) {
      return jsonResponse({ error: 'Unauthenticated' }, 401);
    }

    const group = await this.ctx.storage.get<GroupState>('group');

    if (url.pathname === '/init' && request.method === 'POST') {
      return group ? jsonResponse({ error: 'Group already initialized' }, 409) : this.init(request, caller);
    }

    if (!group) {
      return jsonResponse({ error: 'Group not found' }, 404);
    }

    if (url.pathname === '/join' && request.method === 'POST') {
      return this.join(request, group, caller);
    }

    // Every remaining route is members-only. An unknown group id and a group the
    // caller is not part of are both reported as "not found" so that group ids
    // cannot be probed.
    const member = findMemberByUserId(group, caller.userId);
    if (!member) {
      return jsonResponse({ error: 'Group not found' }, 404);
    }

    if (url.pathname === '/group' && request.method === 'GET') {
      return jsonResponse({ group: this.overview(group, member) });
    }

    if (url.pathname === '/members' && request.method === 'POST') {
      return this.addGuestMember(request, group);
    }

    if (url.pathname === '/quotes' && request.method === 'POST') {
      return this.addQuote(request, group, member);
    }

    if (url.pathname === '/quotes' && request.method === 'GET') {
      if (!areQuotesVisible(group.revealYear)) {
        return lockedResponse(group, 'Quotes');
      }
      return jsonResponse({ quotes: group.quotes, members: group.members.map((entry) => publicMember(entry, member.id)) });
    }

    if (url.pathname === '/quiz' && request.method === 'GET') {
      if (!areQuotesVisible(group.revealYear)) {
        return lockedResponse(group, 'The quiz stays');
      }
      return jsonResponse({ questions: buildQuiz(group) });
    }

    if (url.pathname === '/stats' && request.method === 'GET') {
      if (!areQuotesVisible(group.revealYear)) {
        return lockedResponse(group, 'Statistics');
      }
      return jsonResponse(buildStats(group));
    }

    if (url.pathname === '/invite/rotate' && request.method === 'POST') {
      if (member.role !== 'owner') {
        return jsonResponse({ error: 'Only the group owner can rotate the invite link' }, 403);
      }

      group.inviteVersion += 1;
      await this.ctx.storage.put('group', group);
      return jsonResponse({ inviteVersion: group.inviteVersion });
    }

    return jsonResponse({ error: 'Not found' }, 404);
  }

  private async init(request: Request, caller: Caller): Promise<Response> {
    const body = await readJsonBody(request);
    if (!body.ok) {
      return jsonResponse({ error: body.error }, 400);
    }

    const { id, name, revealYear } = body.value;
    if (typeof id !== 'string' || typeof name !== 'string' || typeof revealYear !== 'number') {
      return jsonResponse({ error: 'Invalid payload' }, 400);
    }

    const owner: Member = {
      id: crypto.randomUUID(),
      name: caller.displayName,
      userId: caller.userId,
      role: 'owner',
      joinedAt: new Date().toISOString(),
    };

    const nextGroup: GroupState = {
      id,
      name,
      revealYear,
      createdAt: new Date().toISOString(),
      ownerUserId: caller.userId,
      inviteVersion: 1,
      members: [owner],
      quotes: [],
    };

    await this.ctx.storage.put('group', nextGroup);
    return jsonResponse({ group: this.overview(nextGroup, owner) }, 201);
  }

  private async join(request: Request, group: GroupState, caller: Caller): Promise<Response> {
    const body = await readJsonBody(request);
    if (!body.ok) {
      return jsonResponse({ error: body.error }, 400);
    }

    if (body.value.inviteVersion !== group.inviteVersion) {
      return jsonResponse({ error: 'This invite link is no longer valid' }, 410);
    }

    const existing = findMemberByUserId(group, caller.userId);
    if (existing) {
      return jsonResponse({ group: this.overview(group, existing) });
    }

    if (group.members.length >= LIMITS.membersPerGroup) {
      return jsonResponse({ error: `A group can hold at most ${LIMITS.membersPerGroup} members` }, 409);
    }

    // Joining never adopts an existing member row. Matching on the display name
    // would let anyone holding the invite code register under a guest's name and
    // inherit that guest's quotes, counts and quiz answers.
    if (hasMemberNamed(group, caller.displayName)) {
      return jsonResponse({ error: 'That name is already taken in this group' }, 409);
    }

    const member: Member = {
      id: crypto.randomUUID(),
      name: caller.displayName,
      userId: caller.userId,
      role: 'member',
      joinedAt: new Date().toISOString(),
    };

    group.members.push(member);
    await this.ctx.storage.put('group', group);
    return jsonResponse({ group: this.overview(group, member) }, 201);
  }

  private async addGuestMember(request: Request, group: GroupState): Promise<Response> {
    const body = await readJsonBody(request);
    if (!body.ok) {
      return jsonResponse({ error: body.error }, 400);
    }

    const name = validateText(body.value.name, 'Member name', LIMITS.memberName);
    if (!name.ok) {
      return jsonResponse({ error: name.error }, 400);
    }

    if (group.members.length >= LIMITS.membersPerGroup) {
      return jsonResponse({ error: `A group can hold at most ${LIMITS.membersPerGroup} members` }, 409);
    }

    if (hasMemberNamed(group, name.value)) {
      return jsonResponse({ error: 'A member with that name already exists' }, 409);
    }

    const member: Member = {
      id: crypto.randomUUID(),
      name: name.value,
      userId: null,
      role: 'member',
      joinedAt: new Date().toISOString(),
    };

    group.members.push(member);
    await this.ctx.storage.put('group', group);
    return jsonResponse({ member: { id: member.id, name: member.name } }, 201);
  }

  private async addQuote(request: Request, group: GroupState, author: Member): Promise<Response> {
    const body = await readJsonBody(request);
    if (!body.ok) {
      return jsonResponse({ error: body.error }, 400);
    }

    // Once the vault is open a quote could be written with full knowledge of what
    // everyone else collected, which would make the leaderboard meaningless.
    if (areQuotesVisible(group.revealYear)) {
      return jsonResponse({ error: 'This group has been revealed and is no longer collecting quotes' }, 409);
    }

    const text = validateText(body.value.text, 'Quote', LIMITS.quoteText);
    if (!text.ok) {
      return jsonResponse({ error: text.error }, 400);
    }

    const involved = validateMemberIdList(body.value.involvedMemberIds, 'Involved members');
    if (!involved.ok) {
      return jsonResponse({ error: involved.error }, 400);
    }

    if (group.quotes.length >= LIMITS.quotesPerGroup) {
      return jsonResponse({ error: `A group can hold at most ${LIMITS.quotesPerGroup} quotes` }, 409);
    }

    const memberIds = new Set(group.members.map((member) => member.id));
    if (typeof body.value.saidByMemberId !== 'string' || !memberIds.has(body.value.saidByMemberId)) {
      return jsonResponse({ error: 'The quoted member is not part of this group' }, 400);
    }

    if (involved.value.some((memberId) => !memberIds.has(memberId))) {
      return jsonResponse({ error: 'An involved member is not part of this group' }, 400);
    }

    const quote = {
      id: crypto.randomUUID(),
      text: text.value,
      saidByMemberId: body.value.saidByMemberId,
      // Always the caller: attribution of who collected a quote is not
      // client-controlled, otherwise the stats could be gamed.
      recordedByMemberId: author.id,
      involvedMemberIds: involved.value,
      createdAt: new Date().toISOString(),
    };

    // Checked before the push: crossing the stored-value ceiling would fail this
    // write and every later one, including joins and invite rotation.
    if (exceedsGroupBudget(group, quote)) {
      return jsonResponse({ error: 'This group has run out of room for new quotes' }, 409);
    }

    group.quotes.push(quote);
    await this.ctx.storage.put('group', group);

    // The quote text is deliberately not echoed back: it would show up in the
    // recorder's own client before the reveal date.
    return jsonResponse({ quote: { id: quote.id, createdAt: quote.createdAt } }, 201);
  }

  private overview(group: GroupState, viewer: Member) {
    const locked = !areQuotesVisible(group.revealYear);

    return {
      id: group.id,
      name: group.name,
      revealYear: group.revealYear,
      revealAt: getRevealAtIso(group.revealYear),
      locked,
      createdAt: group.createdAt,
      inviteVersion: group.inviteVersion,
      you: { memberId: viewer.id, name: viewer.name, role: viewer.role },
      members: group.members.map((member) => publicMember(member, viewer.id)),
      progress: buildProgress(group, viewer.id),
    };
  }
}
