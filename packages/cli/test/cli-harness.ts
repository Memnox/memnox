import { Command } from 'commander';
import { CliContext } from '../src/cli-context';
import { RecordedOutput } from '../src/cli-output';
import { plainStyle } from '../src/style';

interface CliRun {
  out: RecordedOutput;
}

/** For commands whose collaborator would otherwise spawn a process or read $HOME. */
export async function runCommand(
  register: (program: Command, context: CliContext) => void,
  args: string[],
  /* Passed in by the one kind of test that reads the output of a run that threw:
     what a command said on its way to failing is the thing under test. */
  recorder: RecordedOutput = new RecordedOutput(),
): Promise<CliRun> {
  const out = recorder;
  const program = new Command();
  register(program, new CliContext(out, plainStyle));
  await program.parseAsync(args, { from: 'user' });
  return { out };
}
