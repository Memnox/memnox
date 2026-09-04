import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: ['src/index.ts'],
    format: ['esm'],
    dts: true,
    clean: true,
  },
  {
    entry: [
      'src/cli.ts',
      'src/shell-cli.ts',
      'src/git-credential-cli.ts',
      'src/egress-cli.ts',
      'src/docker-cli.ts',
    ],
    format: ['esm'],
    banner: { js: '#!/usr/bin/env node' },
  },
]);
