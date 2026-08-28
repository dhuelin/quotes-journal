import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        isolatedStorage: false,
        miniflare: {
          bindings: {
            AUTH_SECRET: 'test-secret-not-used-in-production',
          },
        },
        wrangler: {
          configPath: './wrangler.toml',
        },
      },
    },
  },
});
