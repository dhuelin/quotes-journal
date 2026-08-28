export type MemberRole = 'owner' | 'member';

export type Member = {
  id: string;
  name: string;
  /** Set when the member joined through an invite; null for guests added by name. */
  userId: string | null;
  role: MemberRole;
  joinedAt: string;
};

export type Quote = {
  id: string;
  text: string;
  saidByMemberId: string;
  recordedByMemberId: string;
  involvedMemberIds: string[];
  createdAt: string;
};

export type GroupState = {
  id: string;
  name: string;
  revealYear: number;
  createdAt: string;
  ownerUserId: string;
  /** Bumped when an invite link is rotated, which invalidates older codes. */
  inviteVersion: number;
  members: Member[];
  quotes: Quote[];
};

/** Caps applied to every request body before anything is persisted. */
export const LIMITS = {
  requestBytes: 16 * 1024,
  groupName: 80,
  memberName: 60,
  displayName: 60,
  email: 254,
  passwordMin: 10,
  passwordMax: 200,
  quoteText: 500,
  involvedMembers: 25,
  membersPerGroup: 100,
  /**
   * A whole group — members and every quote — is one `storage.put('group', …)`,
   * and a Durable Object value tops out at around 2.2MB. Past that *every* write
   * path fails permanently, so this cap has to bite long before the ceiling
   * does: a typical quote serialises to about 750 bytes, which leaves this well
   * inside `groupBytes`.
   */
  quotesPerGroup: 2000,
  /**
   * The real guarantee. A quote carrying the maximum text plus the maximum
   * involved-member list serialises to about 2.7KB, so the count cap alone can
   * still be walked past the ceiling on purpose. Everything below this budget
   * leaves roughly 600KB of the ceiling spare for members and future fields.
   */
  groupBytes: 1_600_000,
  /**
   * The stop line for anything else appended to the stored value. Quotes stop
   * at `groupBytes` so the remaining headroom stays free for members; this cap
   * is what keeps members themselves from walking the group into the ~2.2MB
   * Durable Object ceiling, where every later write would fail for good.
   */
  groupBytesHardCap: 1_900_000,
  groupsPerUser: 50,
} as const;

/**
 * Serialised size of a stored group, in UTF-8 bytes rather than UTF-16 units so
 * that a group full of non-Latin quotes is measured as storage sees it.
 */
export const groupByteSize = (group: GroupState): number => new TextEncoder().encode(JSON.stringify(group)).length;

const sizeWith = (group: GroupState, addition: Quote | Member): number =>
  groupByteSize(group) + new TextEncoder().encode(JSON.stringify(addition)).length + 1;

/** Whether keeping `quote` would push the group past the quote budget. */
export const exceedsGroupBudget = (group: GroupState, quote: Quote): boolean =>
  sizeWith(group, quote) > LIMITS.groupBytes;

/**
 * Whether adding `member` would push the group past the hard cap. Deliberately
 * a looser line than `exceedsGroupBudget`: a group whose quotes have filled
 * their budget must still be able to take on members, or filling it would brick
 * the group in a different way.
 */
export const exceedsGroupHardCap = (group: GroupState, member: Member): boolean =>
  sizeWith(group, member) > LIMITS.groupBytesHardCap;

export const getRevealAtIso = (revealYear: number): string =>
  new Date(Date.UTC(revealYear + 1, 0, 1, 0, 0, 0)).toISOString();

export const areQuotesVisible = (revealYear: number, now: Date = new Date()): boolean =>
  now >= new Date(getRevealAtIso(revealYear));

export const buildQuiz = (group: GroupState) => {
  const options = group.members.map((member) => ({ id: member.id, name: member.name }));

  return group.quotes.map((quote) => ({
    quoteId: quote.id,
    quote: quote.text,
    answerMemberId: quote.saidByMemberId,
    options,
  }));
};

export const buildStats = (group: GroupState) => {
  const persistedBy: Record<string, number> = {};
  const saidBy: Record<string, number> = {};

  for (const member of group.members) {
    persistedBy[member.id] = 0;
    saidBy[member.id] = 0;
  }

  for (const quote of group.quotes) {
    persistedBy[quote.recordedByMemberId] = (persistedBy[quote.recordedByMemberId] ?? 0) + 1;
    saidBy[quote.saidByMemberId] = (saidBy[quote.saidByMemberId] ?? 0) + 1;
  }

  const leaderboard = group.members
    .map((member) => ({
      memberId: member.id,
      name: member.name,
      persisted: persistedBy[member.id] ?? 0,
      said: saidBy[member.id] ?? 0,
    }))
    .sort((left, right) => right.said - left.said || right.persisted - left.persisted);

  return {
    persistedBy,
    saidBy,
    leaderboard,
    totalQuotes: group.quotes.length,
  };
};

/**
 * What the group looks like while quotes are still locked: enough to keep the app
 * useful during the year without spoiling who said what.
 */
export const buildProgress = (group: GroupState, viewerMemberId: string) => ({
  totalQuotes: group.quotes.length,
  recordedByYou: group.quotes.filter((quote) => quote.recordedByMemberId === viewerMemberId).length,
  memberCount: group.members.length,
});

export const findMemberByUserId = (group: GroupState, userId: string): Member | undefined =>
  group.members.find((member) => member.userId === userId);
