import { defineConfig } from 'tsup';

export default defineConfig({
  // Every binary the plan installs ships from this package: npm exposes the bins of
  // what you installed, never those of its dependencies.
  entry: [
    'src/index.ts',
    'src/bin/mcp-proxy.ts',
    'src/bin/shell.ts',
    'src/bin/intercept.ts',
    'src/bin/git-credential.ts',
    'src/bin/egress.ts',
  ],
  format: ['esm'],
  clean: true,
  banner: { js: '#!/usr/bin/env node' },
});
