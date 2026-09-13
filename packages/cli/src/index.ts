import { CliContext } from './cli-context';
import { explain } from './cli-errors';
import { buildProgram } from './program';

const context = new CliContext();

buildProgram(context)
  .parseAsync(process.argv)
  .catch((err: unknown) => {
    const because = explain(err);
    /* On the rail when a command opened one, so the reason reads as the end of
       what was being reported rather than as a crash under it. A run that never
       opened one, whether under `--json` or on a word commander refused
       before any action, has nothing to attach it to and says it plainly. */
    if (context.flow.drawing) context.flow.fail(context.style.warn(because));
    else console.error(because);
    process.exitCode = 1;
  });
