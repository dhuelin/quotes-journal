export type Member = {
  id: string;
  name: string;
};

export type Quote = {
  id: string;
  text: string;
  saidByMemberId: string;
  recordedByMemberId: string;
  involvedMemberIds: string[];
};

export type GroupState = {
  id: string;
  name: string;
  revealYear: number;
  createdAt: string;
  members: Member[];
  quotes: Quote[];
};

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

  return {
    persistedBy,
    saidBy,
  };
};
