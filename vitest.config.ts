import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
  test: {
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
            RATE_LIMIT_READ: '120',
          },
        },
        wrangler: {
          configPath: './wrangler.toml',
        },
      },
    },
  },
});
