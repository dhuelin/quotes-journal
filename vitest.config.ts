import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
  test: {
    // These are integration tests against a real Worker and real Durable
    // Objects, so a single case can make dozens of round trips. Vitest's 5s
    // unit-test default left no margin on a slower CI runner.
    testTimeout: 20_000,
    poolOptions: {
      workers: {
        isolatedStorage: false,
        miniflare: {
          // Pinned rather than inherited: the pool reads wrangler.toml, which
          // pulls in a developer's .dev.vars, and a stray RATE_LIMIT_* there
          // used to fail the rate-limit tests with no hint why.
          bindings: {
            AUTH_SECRET: 'test-secret-not-used-in-production',
            RATE_LIMIT_AUTH: '10',
            RATE_LIMIT_AUTH_ACCOUNT: '5',
            RATE_LIMIT_AUTH_ACCOUNT_WIDE: '8',
            RATE_LIMIT_WRITE: '60',
            // Small on purpose: a test that drains this bucket should cost a
            // handful of requests, not 121. Production defaults live in src.
            RATE_LIMIT_READ: '20',
          },
        },
        wrangler: {
          configPath: './wrangler.toml',
        },
      },
    },
  },
});
