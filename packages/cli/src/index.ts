import { CliContext } from './cli-context';
import { explain } from './cli-errors';
import { buildProgram } from './program';

buildProgram(new CliContext())
  .parseAsync(process.argv)
  .catch((err: unknown) => {
    console.error(explain(err));
    process.exitCode = 1;
  });
