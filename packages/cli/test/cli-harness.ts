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
): Promise<CliRun> {
  const out = new RecordedOutput();
  const program = new Command();
  register(program, new CliContext(out, plainStyle));
  await program.parseAsync(args, { from: 'user' });
  return { out };
}
