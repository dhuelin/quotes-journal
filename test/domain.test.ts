import { describe, expect, it } from 'vitest';
import { areQuotesVisible, buildQuiz, buildStats, getRevealAtIso, type GroupState } from '../src/domain';

describe('domain helpers', () => {
  it('locks quotes before reveal date and unlocks after', () => {
    const revealYear = 2026;
    expect(areQuotesVisible(revealYear, new Date('2026-12-31T23:59:59.999Z'))).toBe(false);
    expect(areQuotesVisible(revealYear, new Date('2027-01-01T00:00:00.000Z'))).toBe(true);
    expect(getRevealAtIso(revealYear)).toBe('2027-01-01T00:00:00.000Z');
  });

  it('builds quiz and stats from group quotes', () => {
    const group: GroupState = {
      id: 'g1',
      name: 'Friends',
      revealYear: 2026,
      createdAt: '2026-01-01T00:00:00.000Z',
      members: [
        { id: 'm1', name: 'A' },
        { id: 'm2', name: 'B' },
      ],
      quotes: [
        {
          id: 'q1',
          text: 'Hello',
          saidByMemberId: 'm1',
          recordedByMemberId: 'm2',
          involvedMemberIds: ['m1', 'm2'],
        },
      ],
    };

    const quiz = buildQuiz(group);
    expect(quiz).toHaveLength(1);
    expect(quiz[0].answerMemberId).toBe('m1');
    expect(quiz[0].options).toHaveLength(2);

    const stats = buildStats(group);
    expect(stats.persistedBy.m2).toBe(1);
    expect(stats.saidBy.m1).toBe(1);
  });
});
