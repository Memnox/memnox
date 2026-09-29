import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const packageSrc = (name: string): string =>
  fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    // Tests run against source so a build step is never required for local development.
    alias: {
      '@memnox/core': packageSrc('core'),
      '@memnox/proxy': packageSrc('proxy'),
      '@memnox/interceptors': packageSrc('interceptors')
    }
  },
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    // A test that falls back to a default seam must land in a temp dir, never in ~/.memnox.
    setupFiles: ['./test-setup/isolated-home.ts'],
    // A floor under the tests nobody has marked: a third of the suite does real filesystem
    // work, and vitest's 5s default was crossed on CI by a test that costs 1.1s locally.
    testTimeout: 10_000,
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts'],
      // Barrel files, constant tables, and binary entry points — process wiring
      // that runs on import. Logic must live one level in, where it is reachable.
      exclude: ['**/index.ts', '**/*.constants.ts', '**/cli.ts'],
      reporter: ['text-summary', 'lcov']
    }
  }
});
