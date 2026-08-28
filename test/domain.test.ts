import { describe, expect, it } from 'vitest';
import {
  areQuotesVisible,
  buildProgress,
  buildQuiz,
  buildStats,
  findMemberByUserId,
  getRevealAtIso,
  type GroupState,
} from '../src/domain';

const group = (): GroupState => ({
  id: 'g1',
  name: 'Friends',
  revealYear: 2026,
  createdAt: '2026-01-01T00:00:00.000Z',
  ownerUserId: 'u1',
  inviteVersion: 1,
  members: [
    { id: 'm1', name: 'Alice', userId: 'u1', role: 'owner', joinedAt: '2026-01-01T00:00:00.000Z' },
    { id: 'm2', name: 'Bob', userId: 'u2', role: 'member', joinedAt: '2026-01-02T00:00:00.000Z' },
    { id: 'm3', name: 'Cleo', userId: null, role: 'member', joinedAt: '2026-01-03T00:00:00.000Z' },
  ],
  quotes: [
    {
      id: 'q1',
      text: 'Hello',
      saidByMemberId: 'm1',
      recordedByMemberId: 'm2',
      involvedMemberIds: ['m1', 'm2'],
      createdAt: '2026-02-01T00:00:00.000Z',
    },
    {
      id: 'q2',
      text: 'Again',
      saidByMemberId: 'm1',
      recordedByMemberId: 'm2',
      involvedMemberIds: [],
      createdAt: '2026-03-01T00:00:00.000Z',
    },
    {
      id: 'q3',
      text: 'Third',
      saidByMemberId: 'm3',
      recordedByMemberId: 'm1',
      involvedMemberIds: [],
      createdAt: '2026-04-01T00:00:00.000Z',
    },
  ],
});

describe('reveal timing', () => {
  it('locks quotes until the first moment of the following year', () => {
    expect(areQuotesVisible(2026, new Date('2026-12-31T23:59:59.999Z'))).toBe(false);
    expect(areQuotesVisible(2026, new Date('2027-01-01T00:00:00.000Z'))).toBe(true);
    expect(getRevealAtIso(2026)).toBe('2027-01-01T00:00:00.000Z');
  });

  it('handles leap years and far-future years', () => {
    expect(getRevealAtIso(2023)).toBe('2024-01-01T00:00:00.000Z');
    expect(getRevealAtIso(2999)).toBe('3000-01-01T00:00:00.000Z');
    expect(areQuotesVisible(2024, new Date('2024-12-31T12:00:00.000Z'))).toBe(false);
  });
});

describe('quiz', () => {
  it('offers every member as an answer option for each quote', () => {
    const quiz = buildQuiz(group());

    expect(quiz).toHaveLength(3);
    expect(quiz[0].answerMemberId).toBe('m1');
    expect(quiz[0].options.map((option) => option.id)).toEqual(['m1', 'm2', 'm3']);
    expect(quiz[2].answerMemberId).toBe('m3');
  });

  it('returns nothing for a group without quotes', () => {
    const empty = group();
    empty.quotes = [];
    expect(buildQuiz(empty)).toEqual([]);
  });
});

describe('stats', () => {
  it('counts quotes said and quotes collected per member', () => {
    const stats = buildStats(group());

    expect(stats.saidBy).toEqual({ m1: 2, m2: 0, m3: 1 });
    expect(stats.persistedBy).toEqual({ m1: 1, m2: 2, m3: 0 });
    expect(stats.totalQuotes).toBe(3);
  });

  it('ranks the leaderboard by quotes said, then by quotes collected', () => {
    const stats = buildStats(group());

    expect(stats.leaderboard.map((entry) => entry.name)).toEqual(['Alice', 'Cleo', 'Bob']);
    expect(stats.leaderboard[0]).toMatchObject({ name: 'Alice', said: 2, persisted: 1 });
  });

  it('includes members with no activity at zero', () => {
    const solo = group();
    solo.quotes = [];

    expect(buildStats(solo).leaderboard.every((entry) => entry.said === 0 && entry.persisted === 0)).toBe(true);
  });
});

describe('progress while locked', () => {
  it('reports totals without revealing who said what', () => {
    const progress = buildProgress(group(), 'm2');

    expect(progress).toEqual({ totalQuotes: 3, recordedByYou: 2, memberCount: 3 });
    expect(JSON.stringify(progress)).not.toContain('Hello');
  });
});

describe('member lookup', () => {
  it('finds members by the account that joined, ignoring guests', () => {
    expect(findMemberByUserId(group(), 'u2')?.name).toBe('Bob');
    expect(findMemberByUserId(group(), 'nobody')).toBeUndefined();
  });
});
