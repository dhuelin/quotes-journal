import { describe, expect, it } from 'vitest';
import {
  areQuotesVisible,
  buildProgress,
  canMoveReveal,
  quoteLinesOf,
  quoteSpeakers,
  revealInstant,
  buildQuiz,
  QUIZ,
  scoreAnswer,
  buildStats,
  exceedsGroupBudget,
  exceedsImageBudget,
  findMemberByUserId,
  getRevealAtIso,
  groupByteSize,
  groupImageByteSize,
  LIMITS,
  type GroupState,
  type Quote,
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
  it('locks quotes until the first moment of the following year by default', () => {
    expect(areQuotesVisible({ revealYear: 2026 }, new Date('2026-12-31T23:59:59.999Z'))).toBe(false);
    expect(areQuotesVisible({ revealYear: 2026 }, new Date('2027-01-01T00:00:00.000Z'))).toBe(true);
    expect(getRevealAtIso(2026)).toBe('2027-01-01T00:00:00.000Z');
  });

  it('handles leap years and far-future years', () => {
    expect(getRevealAtIso(2023)).toBe('2024-01-01T00:00:00.000Z');
    expect(getRevealAtIso(2999)).toBe('3000-01-01T00:00:00.000Z');
    expect(areQuotesVisible({ revealYear: 2024 }, new Date('2024-12-31T12:00:00.000Z'))).toBe(false);
  });

  it('opens on a chosen instant instead, to the millisecond', () => {
    // The Christmas-party case: a group that wants to read its quotes on the
    // 29th rather than waiting for midnight on 1 January.
    const party = { revealYear: 2026, revealAt: '2026-12-29T19:00:00.000Z' };

    expect(areQuotesVisible(party, new Date('2026-12-29T18:59:59.999Z'))).toBe(false);
    expect(areQuotesVisible(party, new Date('2026-12-29T19:00:00.000Z'))).toBe(true);
    // And the default no longer applies, in either direction.
    expect(areQuotesVisible(party, new Date('2026-12-30T00:00:00.000Z'))).toBe(true);
  });

  it('leaves a group stored before the date was configurable exactly where it was', () => {
    // The migration story: there is none, because a group with no instant keeps
    // deriving the one it has always had. Nothing shifts mid-collection.
    const legacy = { revealYear: 2026 };

    expect(revealInstant(legacy)).toBe('2027-01-01T00:00:00.000Z');
    expect(revealInstant({ revealYear: 2026, revealAt: '2026-12-29T19:00:00.000Z' })).toBe(
      '2026-12-29T19:00:00.000Z',
    );
  });
});

/**
 * The rule the product rests on. Everyone who recorded a quote did so on the
 * promise that nobody reads it before a stated moment; pulling that moment
 * forward breaks a promise they cannot take back.
 */
describe('moving the reveal', () => {
  const sealed = { revealYear: 2026, revealAt: '2026-12-29T19:00:00.000Z' };
  const during = new Date('2026-06-01T00:00:00.000Z');

  it('allows a later date', () => {
    expect(canMoveReveal(sealed, '2026-12-31T19:00:00.000Z', during).ok).toBe(true);
  });

  it('refuses an earlier one, and refuses standing still', () => {
    const earlier = canMoveReveal(sealed, '2026-12-01T19:00:00.000Z', during);
    expect(earlier.ok).toBe(false);
    expect(earlier.ok === false && earlier.error).toContain('only be moved later');

    // The same instant is not a move, and allowing it would only ever be a way
    // to reset the "moved" marker.
    expect(canMoveReveal(sealed, sealed.revealAt, during).ok).toBe(false);
  });

  it('refuses any change once the group has opened', () => {
    // Re-sealing would re-open collecting to people who have now read
    // everything everyone else wrote.
    const after = new Date('2027-01-05T00:00:00.000Z');

    expect(canMoveReveal(sealed, '2027-06-01T00:00:00.000Z', after).ok).toBe(false);
    expect(canMoveReveal(sealed, '2027-06-01T00:00:00.000Z', after)).toMatchObject({
      error: expect.stringContaining('already opened'),
    });
  });

  it('measures a legacy group against the instant it derives', () => {
    const legacy = { revealYear: 2026 };

    expect(canMoveReveal(legacy, '2027-03-01T00:00:00.000Z', during).ok).toBe(true);
    expect(canMoveReveal(legacy, '2026-12-29T00:00:00.000Z', during).ok).toBe(false);
  });
});

describe('quiz', () => {
  it('offers every member as an answer option for each quote', () => {
    const quiz = buildQuiz(group());

    expect(quiz).toHaveLength(3);
    expect(quiz[0].options.map((option) => option.id)).toEqual(['m1', 'm2', 'm3']);
  });

  it('never ships the answer to the client', () => {
    // The point of scoring on the server. With the answer in the payload, a
    // score is worth exactly as much as the honesty of whoever opened devtools.
    expect(JSON.stringify(buildQuiz(group()))).not.toContain('answerMemberId');
    expect(JSON.stringify(buildQuiz(group()))).not.toContain('saidByMemberId');
  });

  it('returns nothing for a group without quotes', () => {
    const empty = group();
    empty.quotes = [];
    expect(buildQuiz(empty)).toEqual([]);
  });
});

describe('quiz scoring', () => {
  it('pays everything for an instant answer and half at the buzzer', () => {
    expect(scoreAnswer(true, 0)).toBe(QUIZ.maxPoints);
    expect(scoreAnswer(true, QUIZ.answerWindowMs)).toBe(QUIZ.maxPoints / 2);
    expect(scoreAnswer(true, QUIZ.answerWindowMs / 2)).toBe(750);
  });

  it('pays nothing for a wrong answer, however fast', () => {
    expect(scoreAnswer(false, 0)).toBe(0);
    expect(scoreAnswer(false, QUIZ.answerWindowMs)).toBe(0);
  });

  it('never pays more than full or less than half for a correct answer', () => {
    // A clock that runs backwards, or a question left open for an hour, are
    // both arithmetic the score has to survive.
    expect(scoreAnswer(true, -5_000)).toBe(QUIZ.maxPoints);
    expect(scoreAnswer(true, 60 * 60 * 1000)).toBe(QUIZ.maxPoints / 2);
  });

  it('rewards speed without letting it decide the game alone', () => {
    // The slowest correct answer is still worth half the fastest, so two right
    // answers at the buzzer are never worth less than one instant one: knowing
    // the group cannot be beaten by a fast thumb alone.
    expect(scoreAnswer(true, QUIZ.answerWindowMs) * 2).toBeGreaterThanOrEqual(scoreAnswer(true, 0));
    expect(scoreAnswer(true, QUIZ.answerWindowMs)).toBeGreaterThan(scoreAnswer(false, 0));
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

/**
 * A group is stored as a single Durable Object value, and that value has a hard
 * ceiling of roughly 2.2MB. Crossing it fails every later write — quotes, guest
 * members, joins and invite rotation alike — with no way back, so the caps have
 * to be provably on the safe side of it.
 */
describe('the stored-value budget', () => {
  const DO_VALUE_CEILING_BYTES = 2_200_000;
  const bytesOf = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).length;

  const quote = (involved: number, text: string): Quote => ({
    id: crypto.randomUUID(),
    text,
    saidByMemberId: crypto.randomUUID(),
    recordedByMemberId: crypto.randomUUID(),
    involvedMemberIds: Array.from({ length: involved }, () => crypto.randomUUID()),
    createdAt: new Date().toISOString(),
  });

  it('leaves the ceiling room for the members alongside a budget-full quote list', () => {
    const members = Array.from({ length: LIMITS.membersPerGroup }, () => ({
      id: crypto.randomUUID(),
      name: 'n'.repeat(LIMITS.memberName),
      userId: crypto.randomUUID(),
      role: 'member' as const,
      joinedAt: new Date().toISOString(),
    }));

    expect(LIMITS.groupBytes + bytesOf(members)).toBeLessThan(DO_VALUE_CEILING_BYTES);
  });

  it('keeps the quote count cap inside the byte budget for maximum-length quotes', () => {
    const full = bytesOf(quote(0, 'x'.repeat(LIMITS.quoteText)));

    expect(LIMITS.quotesPerGroup * full).toBeLessThan(LIMITS.groupBytes);
  });

  it('stops a worst-case quote stream at the budget, well short of the ceiling', () => {
    // The count cap alone is not enough: max text plus a full involved-member
    // list is several times an ordinary quote, so the byte budget is what
    // actually guarantees the group stays writable.
    const worst = quote(LIMITS.involvedMembers, '漢'.repeat(LIMITS.quoteText));
    expect(LIMITS.quotesPerGroup * bytesOf(worst)).toBeGreaterThan(DO_VALUE_CEILING_BYTES);

    const filling: GroupState = { ...group(), quotes: [] };
    const perQuote = bytesOf(worst);
    filling.quotes = Array.from({ length: Math.floor(LIMITS.groupBytes / perQuote) }, () =>
      quote(LIMITS.involvedMembers, '漢'.repeat(LIMITS.quoteText)),
    );

    expect(exceedsGroupBudget(filling, worst)).toBe(true);
    expect(groupByteSize(filling)).toBeLessThan(DO_VALUE_CEILING_BYTES);
  });

  it('allows a quote while there is room', () => {
    expect(exceedsGroupBudget(group(), quote(0, 'still plenty of room'))).toBe(false);
  });
});

/**
 * The client is served under `style-src 'sha256-…'`. A hash names an inline
 * <style> block; a style="" attribute cannot be named at all and browsers drop
 * it silently — no test that stops at the HTTP layer can see that, so guard the
 * source instead.
 */
describe('the inlined client under CSP', () => {
  it('carries no inline style attributes on any page', async () => {
    const { renderAppHtml, renderPrivacyHtml } = await import('../src/ui');

    // Every page under the policy, not just the app: a style="" attribute is
    // outside what a hash or a nonce can authorise, either way.
    expect(renderAppHtml()).not.toContain('style="');
    expect(renderPrivacyHtml()).not.toContain('style="');
  });

  it('carries no script at all on the privacy page', async () => {
    const { renderPrivacyHtml } = await import('../src/ui');

    // Nothing to execute means nothing for the policy to authorise.
    expect(renderPrivacyHtml()).not.toContain('<script');
  });

  it('sets no maxlength, so a pasted over-long value is reported rather than trimmed', async () => {
    const { renderAppHtml } = await import('../src/ui');

    // Silent truncation hid an error the server states clearly; a counter and
    // the server's own message replaced it.
    expect(renderAppHtml()).not.toContain('maxlength=');
    // One counter per line of a quote, since the limit is per line.
    expect(renderAppHtml()).toContain("id=\"quote-count-'");
  });

  it('carries no backtick or interpolation into the inlined blocks', async () => {
    const { appInline, privacyInline } = await import('../src/ui');

    // The client lives inside a template literal, so a backtick written in it —
    // in a comment as easily as in code — ends the string early, and a `${`
    // silently interpolates. Either one ships a client that does not run.
    for (const block of [appInline.styles, appInline.script, privacyInline.styles]) {
      expect(block).not.toContain('`');
      expect(block).not.toContain('${');
    }
  });

  it('escapes nothing into a regex literal, which a template literal would eat', async () => {
    const { renderAppHtml } = await import('../src/ui');

    // ui.ts is one big template literal: a backslash written here never reaches
    // the browser, so a regex like /^\/groups/ silently becomes /^/groups/ and
    // throws "invalid flags" at load. Path parsing uses split() instead.
    expect(renderAppHtml()).not.toMatch(/match\(\/\^/);
  });

  it('asks for the password twice at registration and never sends the second copy', async () => {
    const { renderAppHtml } = await import('../src/ui');
    const page = renderAppHtml();

    // There is no password reset yet (#6), so a typo at registration locks
    // someone out of an account they cannot recover.
    expect(page).toContain('id="register-confirm"');
    expect(page).toContain('Repeat password');
    expect(page).toContain('form.password.value !== form.passwordConfirm.value');
    // The confirmation is a browser-side typo check; the API takes one password.
    expect(page).not.toContain('passwordConfirm:');
  });

  it('offers a picture field that is prepared on the device before upload', async () => {
    const { renderAppHtml } = await import('../src/ui');
    const page = renderAppHtml();

    expect(page).toContain('id="quote-photo"');
    expect(page).toContain('accept="image/jpeg,image/png,image/webp"');
    // Re-encoding through a canvas is what strips the EXIF block, GPS included.
    expect(page).toContain('createImageBitmap');
    // A picture is fetched with the bearer token, never through a URL that
    // would have to carry a credential.
    expect(page).toContain("authorization: 'Bearer ' + state.token");
  });

  it('hashes exactly the bytes it serves between the tags', async () => {
    const { appInline, privacyInline, renderAppHtml, renderPrivacyHtml } = await import('../src/ui');
    const { policies } = await import('../src/csp');
    const page = renderAppHtml();

    // The whole scheme rests on this: what the policy names and what the browser
    // runs have to be the same bytes. They are interpolated, so they are — and
    // this is the test that notices if anyone reintroduces a wrapper or a trim.
    expect(page).toContain(`<style>${appInline.styles}</style>`);
    expect(page).toContain(`<script>${appInline.script}</script>`);
    expect(renderPrivacyHtml()).toContain(`<style>${privacyInline.styles}</style>`);
    expect(page).not.toContain('__CSP_NONCE__');

    const policy = await policies();
    expect(policy.app).toMatch(/script-src 'sha256-[A-Za-z0-9+/=]{44}'/);
    expect(policy.app).toMatch(/style-src 'sha256-[A-Za-z0-9+/=]{44}'/);
    // The privacy page has no script, so it authorises none.
    expect(policy.privacy).not.toContain('script-src');
  });

  it('fingerprints the client so a deployed change reaches an installed app', async () => {
    const { policies } = await import('../src/csp');

    // The service worker names its cache with this. If it did not change when
    // the client changes, a browser would keep serving a shell cached months
    // ago and never install the new worker that would have replaced it.
    const { version } = await policies();
    expect(version).toMatch(/^[A-Za-z0-9]{16}$/);
  });
});

/**
 * Picture bytes live in their own Durable Object keys, so they cannot push the
 * stored group value towards its ceiling. What they can do is fill the object's
 * database, which is what this budget is for.
 */
describe('the picture budget', () => {
  const withImages = (count: number, bytes: number): GroupState => {
    const state = group();
    state.quotes = Array.from({ length: count }, (_unused, index) => ({
      id: `q${index}`,
      text: 'x',
      saidByMemberId: 'm1',
      recordedByMemberId: 'm1',
      involvedMemberIds: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      image: { contentType: 'image/jpeg' as const, bytes, addedAt: '2026-01-01T00:00:00.000Z' },
    }));
    return state;
  };

  it('adds up only the quotes that carry a picture', () => {
    expect(groupImageByteSize(group())).toBe(0);
    expect(groupImageByteSize(withImages(3, 1000))).toBe(3000);
  });

  it('stops an upload that would cross the budget', () => {
    const full = withImages(Math.floor(LIMITS.groupImageBytes / LIMITS.quoteImageBytes), LIMITS.quoteImageBytes);

    expect(exceedsImageBudget(full, 'unseen-quote', LIMITS.quoteImageBytes)).toBe(true);
  });

  it('does not count the picture being replaced against the one replacing it', () => {
    const full = withImages(Math.floor(LIMITS.groupImageBytes / LIMITS.quoteImageBytes), LIMITS.quoteImageBytes);

    // Swapping the wrong photo for the right one must not be refused just
    // because the group happens to be at its budget.
    expect(exceedsImageBudget(full, 'q0', LIMITS.quoteImageBytes)).toBe(false);
  });

  it('leaves the whole picture budget outside the stored group value', () => {
    // Metadata only: three numbers and a short string per quote, nowhere near
    // the value ceiling even with every quote carrying a picture.
    const many = withImages(LIMITS.quotesPerGroup, LIMITS.quoteImageBytes);

    expect(groupByteSize(many)).toBeLessThan(LIMITS.groupBytes);
    expect(groupImageByteSize(many)).toBeGreaterThan(LIMITS.groupBytes);
  });
});

/**
 * A quote with more than one speaker. The single-speaker quote is the one-line
 * case, so nothing already recorded changes shape.
 */
describe('conversations', () => {
  const exchange = (): Quote => ({
    id: 'q9',
    // Mirrors of the opening line, kept so a reader that predates conversations
    // still shows something correct.
    text: 'I am not lost.',
    saidByMemberId: 'm1',
    recordedByMemberId: 'm2',
    involvedMemberIds: [],
    createdAt: '2026-05-01T00:00:00.000Z',
    lines: [
      { saidByMemberId: 'm1', text: 'I am not lost.' },
      { saidByMemberId: 'm2', text: 'You have been driving in circles for twenty minutes.' },
      { saidByMemberId: 'm1', text: 'Scenically.' },
    ],
  });

  it('reads a single remark as a one-line exchange', () => {
    const [line, ...rest] = quoteLinesOf(group().quotes[0]);

    expect(rest).toHaveLength(0);
    expect(line).toEqual({ saidByMemberId: 'm1', text: 'Hello' });
  });

  it('counts a speaker once however many lines they have', () => {
    // Otherwise the leaderboard would reward rambling rather than being quotable.
    expect(quoteSpeakers(exchange())).toEqual(['m1', 'm2']);
  });

  it('credits every speaker in an exchange, and the recorder only once', () => {
    const withExchange = group();
    withExchange.quotes = [exchange()];

    const stats = buildStats(withExchange);

    expect(stats.saidBy).toEqual({ m1: 1, m2: 1, m3: 0 });
    expect(stats.persistedBy).toEqual({ m1: 0, m2: 1, m3: 0 });
    // One quote, two people in it: the totals across members can exceed the
    // quote count, which is the honest reading of "quotes you are in".
    expect(stats.totalQuotes).toBe(1);
  });

  it('keeps the opening line as the fallback view of the quote', () => {
    const quote = exchange();

    // A client that knows nothing about `lines` shows this, correctly attributed.
    expect(quote.text).toBe(quote.lines![0].text);
    expect(quote.saidByMemberId).toBe(quote.lines![0].saidByMemberId);
  });
});
