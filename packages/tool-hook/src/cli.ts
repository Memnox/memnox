import { HookSession } from './hook-session';
import { buildAuthorizer, log, readStdin } from './seam-runtime';
import { EXIT_UNUSABLE_INPUT } from './tool-hook.constants';

async function main(): Promise<void> {
  const session = new HookSession({ authorizer: await buildAuthorizer(), log });
  const outcome = await session.handle(await readStdin());
  if (outcome.stdout.length > 0) process.stdout.write(outcome.stdout);
  process.exitCode = outcome.exitCode;
}

main().catch((err: unknown) => {
  // A hook that throws must not read as a refusal; it ruled on nothing and says so.
  log(`hook failed, ruling on nothing: ${String(err)}`);
  process.exitCode = EXIT_UNUSABLE_INPUT;
});
