import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: ['src/index.ts'],
    format: ['esm'],
    dts: true,
    clean: true,
  },
  {
    // One entry per binary the interceptor directory and the seams install.
    entry: [
      'src/interceptor-cli.ts',
      'src/shell-cli.ts',
      'src/git-credential-cli.ts',
      'src/egress-cli.ts',
    ],
    format: ['esm'],
    banner: { js: '#!/usr/bin/env node' },
  },
]);
