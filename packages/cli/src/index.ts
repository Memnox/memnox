import { CliContext } from './cli-context';
import { describeConnectionFailure, ENV_RUNTIME_URL } from './connection';
import { DEFAULT_BASE_URL } from './defaults';
import { buildProgram } from './program';

/** The single failure path: "fetch failed" names neither the address nor the fix. */
function explain(err: unknown): string {
  const url = process.env[ENV_RUNTIME_URL] ?? DEFAULT_BASE_URL;
  const connection = describeConnectionFailure(err, url);
  if (connection !== null) return connection;
  return err instanceof Error ? err.message : String(err);
}

buildProgram(new CliContext())
  .parseAsync(process.argv)
  .catch((err: unknown) => {
    console.error(explain(err));
    process.exitCode = 1;
  });
