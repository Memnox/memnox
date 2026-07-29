import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const packageSrc = (name: string): string =>
  fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    // Tests run against source so a build step is never required for local development.
    alias: {
      '@memnox/core': packageSrc('core'),
      '@memnox/policy-engine': packageSrc('policy-engine'),
      '@memnox/content-shield': packageSrc('content-shield'),
      '@memnox/local-gate': packageSrc('local-gate'),
      '@memnox/code-graph': packageSrc('code-graph'),
      '@memnox/trust-bench': packageSrc('trust-bench'),
      '@memnox/redis': packageSrc('redis'),
      '@memnox/memory': packageSrc('memory'),
      '@memnox/risk': packageSrc('risk'),
      '@memnox/runtime': packageSrc('runtime'),
      '@memnox/sdk': packageSrc('sdk'),
      '@memnox/intelligence': packageSrc('intelligence'),
      '@memnox/mcp-firewall': packageSrc('mcp-firewall'),
      '@memnox/postgres': packageSrc('postgres'),
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts'],
      // Barrel files, constant tables, and binary entry points — process wiring
      // that runs on import. Logic must live one level in, where it is reachable.
      exclude: ['**/index.ts', '**/*.constants.ts', '**/cli.ts'],
      reporter: ['text-summary', 'lcov'],
    },
  },
});
