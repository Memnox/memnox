import { homedir } from 'node:os';
import { EXIT } from '@memnox/core';
import { CliContext } from './cli-context';
import { describeError } from './cli-errors';
import { readKept } from './keeper/kept';
import { buildProgram, withDefaultCommand } from './program';

const context = new CliContext();

readKept(homedir())
  .then((kept) =>
    buildProgram(context).parseAsync(withDefaultCommand(process.argv, kept !== null)),
  )
  .catch((err: unknown) => {
    const because = describeError(err);
    // On the rail when a command opened one, so the reason reads as the end of the report
    // rather than a crash; a run with no rail has nothing to attach it to.
    if (context.flow.drawing) context.flow.fail(context.style.warn(because));
    else console.error(because);
    process.exitCode = EXIT.FAILED;
  });
