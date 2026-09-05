import { readFile } from 'node:fs/promises';
import type { Command } from 'commander';
import { verifyBundle, VERIFY_RESULT, type Bundle } from '@memnox/core';
import type { CliContext } from '../cli-context';

/**
 * The other half of a signed export. An auditor who cannot check a bundle is looking
 * at a file somebody could have edited, so the checker ships with the thing that
 * signs — and it needs nothing from us, because the key travels with the bundle.
 */
export function registerVerifyCommand(program: Command, context: CliContext): void {
  program
    .command('verify <bundle>')
    .description('Check an exported bundle against its signature')
    .action(async (path: string) => {
      const raw = await readFile(path, 'utf8');
      const split = raw.indexOf('\n\n');
      if (split === -1) {
        throw new Error(`${path} is not a Memnox bundle — no header was found.`);
      }

      let header: Bundle;
      try {
        header = JSON.parse(raw.slice(0, split)) as Bundle;
      } catch {
        throw new Error(`${path} has a header that is not JSON.`);
      }

      /* The file ends with a newline the way every text file does, and it is not part
         of what was signed. Counting it would make every honest bundle read as edited. */
      const body = raw.slice(split + 2).replace(/\n$/, '');
      const check = verifyBundle(header, body);
      const { out, style } = context;

      out.line(
        check.result === VERIFY_RESULT.VALID
          ? style.ok(`VALID    ${check.detail}`)
          : style.warn(`${check.result.toUpperCase().padEnd(9)}${check.detail}`),
      );
      if (header.excluded.length > 0) {
        out.line('');
        out.line('  Left out of this bundle:');
        for (const each of header.excluded) out.line(`    ${each}`);
      }
      if (check.result !== VERIFY_RESULT.VALID) process.exitCode = 1;
    });
}
