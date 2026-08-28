import { describe, expect, it } from 'vitest';
import { LIMITS } from '../src/domain';
import { nextBucketState } from '../src/rate-limiter';
import {
  readJsonBody,
  validateEmail,
  validateMemberIdList,
  validatePassword,
  validateRevealYear,
  validateText,
} from '../src/validation';

const jsonRequest = (body: string): Request =>
  new Request('https://example.com/', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });

describe('validateText', () => {
  it('trims and accepts ordinary input', () => {
    expect(validateText('  Alice  ', 'Name', 20)).toEqual({ ok: true, value: 'Alice' });
  });

  it('rejects empty, over-long and non-string input', () => {
    expect(validateText('   ', 'Name', 20).ok).toBe(false);
    expect(validateText('x'.repeat(21), 'Name', 20).ok).toBe(false);
    expect(validateText(42, 'Name', 20).ok).toBe(false);
    expect(validateText(undefined, 'Name', 20).ok).toBe(false);
  });

  it('rejects control characters that would break rendering', () => {
    expect(validateText('Ali\u0007ce', 'Name', 20).ok).toBe(false);
    expect(validateText('line\nbreak', 'Name', 20).ok).toBe(false);
  });

  it('honours a minimum length', () => {
    expect(validateText('a', 'Name', 20, { minLength: 2 }).ok).toBe(false);
    expect(validateText('ab', 'Name', 20, { minLength: 2 }).ok).toBe(true);
  });
});

describe('validateEmail', () => {
  it('normalises case', () => {
    expect(validateEmail('Alice@Example.COM')).toEqual({ ok: true, value: 'alice@example.com' });
  });

  it('rejects addresses without a domain part', () => {
    for (const value of ['alice', 'alice@', '@example.com', 'alice@example', 'a b@example.com']) {
      expect(validateEmail(value).ok, value).toBe(false);
    }
  });
});

describe('validatePassword', () => {
  it('enforces the length window without trimming', () => {
    expect(validatePassword('short').ok).toBe(false);
    expect(validatePassword('   spaces   ')).toEqual({ ok: true, value: '   spaces   ' });
    expect(validatePassword('x'.repeat(LIMITS.passwordMax + 1)).ok).toBe(false);
  });
});

describe('validateRevealYear', () => {
  const now = new Date('2026-06-01T00:00:00.000Z');

  it('defaults to the current year', () => {
    expect(validateRevealYear(undefined, now)).toEqual({ ok: true, value: 2026 });
  });

  it('refuses past years, so a group cannot be created already unlocked', () => {
    expect(validateRevealYear(2025, now).ok).toBe(false);
    expect(validateRevealYear(2026, now).ok).toBe(true);
  });

  it('refuses years too far out and non-integers', () => {
    expect(validateRevealYear(2037, now).ok).toBe(false);
    expect(validateRevealYear(2026.5, now).ok).toBe(false);
    expect(validateRevealYear('2026', now).ok).toBe(false);
  });
});

describe('validateMemberIdList', () => {
  it('defaults to an empty list and removes duplicates', () => {
    expect(validateMemberIdList(undefined, 'Involved')).toEqual({ ok: true, value: [] });
    expect(validateMemberIdList(['a', 'a', 'b'], 'Involved')).toEqual({ ok: true, value: ['a', 'b'] });
  });

  it('rejects oversized lists and non-string entries', () => {
    const tooMany = Array.from({ length: LIMITS.involvedMembers + 1 }, (_, index) => `m${index}`);

    expect(validateMemberIdList(tooMany, 'Involved').ok).toBe(false);
    expect(validateMemberIdList([1, 2], 'Involved').ok).toBe(false);
    expect(validateMemberIdList('a,b', 'Involved').ok).toBe(false);
  });
});

describe('readJsonBody', () => {
  it('accepts a JSON object', async () => {
    expect(await readJsonBody(jsonRequest('{"a":1}'))).toEqual({ ok: true, value: { a: 1 } });
  });

  it('rejects malformed JSON, arrays and primitives', async () => {
    expect((await readJsonBody(jsonRequest('not json'))).ok).toBe(false);
    expect((await readJsonBody(jsonRequest('[1,2]'))).ok).toBe(false);
    expect((await readJsonBody(jsonRequest('"text"'))).ok).toBe(false);
    expect((await readJsonBody(jsonRequest('null'))).ok).toBe(false);
  });

  it('rejects a body over the size cap', async () => {
    const oversized = JSON.stringify({ text: 'x'.repeat(LIMITS.requestBytes) });
    const result = await readJsonBody(jsonRequest(oversized));

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain('too large');
  });
});

describe('rate limit bucket', () => {
  const limit = 5;
  const windowMs = 60_000;

  it('allows a burst up to the limit and then blocks', () => {
    let state = { tokens: limit, updatedAt: 0 };

    for (let attempt = 0; attempt < limit; attempt += 1) {
      const result = nextBucketState(state, limit, windowMs, 0);
      expect(result.decision.allowed, `attempt ${attempt}`).toBe(true);
      state = result.state;
    }

    const blocked = nextBucketState(state, limit, windowMs, 0);
    expect(blocked.decision.allowed).toBe(false);
    expect(blocked.decision.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('refills continuously as time passes', () => {
    const spent = { tokens: 0, updatedAt: 0 };

    expect(nextBucketState(spent, limit, windowMs, windowMs / limit - 1).decision.allowed).toBe(false);
    expect(nextBucketState(spent, limit, windowMs, windowMs / limit).decision.allowed).toBe(true);
  });

  it('never refills past the limit', () => {
    const stale = { tokens: 0, updatedAt: 0 };
    const result = nextBucketState(stale, limit, windowMs, windowMs * 100);

    expect(result.state.tokens).toBe(limit - 1);
  });
});
