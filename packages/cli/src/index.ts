import { CliContext } from './cli-context';
import { buildProgram } from './program';

buildProgram(new CliContext())
  .parseAsync(process.argv)
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
