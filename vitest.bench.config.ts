import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const packageSrc = (name: string): string =>
  fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

/**
 * The benchmarks, which the ordinary suite deliberately does not run: they assert wall
 * clock, so they answer a question about this machine at this moment rather than about
 * the code. Kept runnable, because a requirement nobody measures stops being one.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@memnox/core': packageSrc('core'),
      '@memnox/proxy': packageSrc('proxy'),
      '@memnox/interceptors': packageSrc('interceptors'),
    },
  },
  test: {
    include: ['packages/*/test/**/*.bench.ts'],
    // One at a time: benchmarks that share a machine measure each other.
    fileParallelism: false,
  },
});
