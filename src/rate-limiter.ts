/**
 * Token-bucket rate limiter backed by one Durable Object per bucket key
 * (for example `login:203.0.113.4`). The bucket refills continuously, so a
 * caller that stays under the average rate is never blocked while a burst is.
 */
export type RateLimitDecision = {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
};

type BucketState = {
  tokens: number;
  updatedAt: number;
};

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });

/**
 * `consume: false` reports whether a token is available without spending one.
 * The auth routes peek before doing the password work and only spend a token
 * when the attempt actually fails, so a correct sign-in never counts against
 * the account and cannot be used to lock its owner out.
 */
export const nextBucketState = (
  state: BucketState,
  limit: number,
  windowMs: number,
  now: number,
  consume = true,
): { state: BucketState; decision: RateLimitDecision } => {
  const elapsed = Math.max(0, now - state.updatedAt);
  const refilled = Math.min(limit, state.tokens + (elapsed / windowMs) * limit);

  if (refilled < 1) {
    const msUntilNextToken = ((1 - refilled) * windowMs) / limit;
    return {
      state: { tokens: refilled, updatedAt: now },
      decision: {
        allowed: false,
        remaining: 0,
        retryAfterSeconds: Math.max(1, Math.ceil(msUntilNextToken / 1000)),
      },
    };
  }

  const tokens = consume ? refilled - 1 : refilled;
  return {
    state: { tokens, updatedAt: now },
    decision: { allowed: true, remaining: Math.floor(tokens), retryAfterSeconds: 0 },
  };
};

export class RateLimiter {
  constructor(private readonly ctx: DurableObjectState, private readonly _env: unknown) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const limit = Number(url.searchParams.get('limit') ?? '30');
    const windowMs = Number(url.searchParams.get('windowMs') ?? '60000');

    if (!Number.isFinite(limit) || limit <= 0 || !Number.isFinite(windowMs) || windowMs <= 0) {
      return jsonResponse({ error: 'Invalid rate limit configuration' }, 400);
    }

    const now = Date.now();
    const consume = url.searchParams.get('consume') !== '0';
    const stored = (await this.ctx.storage.get<BucketState>('bucket')) ?? { tokens: limit, updatedAt: now };
    const { state, decision } = nextBucketState(stored, limit, windowMs, now, consume);

    await this.ctx.storage.put('bucket', state);
    return jsonResponse(decision);
  }
}
