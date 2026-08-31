import { GitCredentialSeam } from './git-credential-seam';
import { buildAuthorizer, log, readStdin } from './seam-runtime';

/** git calls a helper with one of these; only `get` hands anything out. */
const OPERATION_GET = 'get';

async function main(): Promise<void> {
  const operation = process.argv[2];
  // store and erase change git's own cache and hand nothing over; they pass through.
  if (operation !== OPERATION_GET) return;

  const seam = new GitCredentialSeam({ authorizer: await buildAuthorizer() });
  const outcome = await seam.gate(await readStdin());

  if (outcome.message !== undefined) log(outcome.message);
  if (outcome.stdout.length > 0) process.stdout.write(outcome.stdout);
}

main().catch((err: unknown) => {
  /* Silence on failure, deliberately: writing `quit=1` here would block every clone
     the moment this seam has a bad day, and a governance tool that breaks git at 2am
     is the one that gets uninstalled. The gap is logged instead. */
  log(`git seam failed, ruling on nothing: ${String(err)}`);
});
