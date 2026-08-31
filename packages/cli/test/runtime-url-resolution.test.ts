import { describe, expect, it } from 'vitest';
import { CliContext } from '../src/cli-context';
import { RecordedOutput } from '../src/cli-output';
import { ENV_RUNTIME_URL } from '../src/connection';
import { buildProgram } from '../src/program';
import { plainStyle } from '../src/style';
import { FakeRuntime } from './cli-harness';

const ENV_URL = 'http://env-runtime.test:1234';
const STORED_URL = 'http://stored-runtime.test:5678';
const FLAG_URL = 'http://flag-runtime.test:9012';

/** Every command that reads the runtime must resolve its address the same way. */
const CLIENT_COMMANDS: { name: string; argv: string[] }[] = [
  { name: 'agents list', argv: ['agents', 'list'] },
  { name: 'coverage', argv: ['coverage'] },
  { name: 'audit', argv: ['audit'] },
  { name: 'evidence', argv: ['evidence'] },
  { name: 'memory list', argv: ['memory', 'list'] },
];

/** The address the command actually dialled, or a failure naming the command. */
async function dialledUrl(argv: string[], env: NodeJS.ProcessEnv): Promise<string> {
  const runtime = new FakeRuntime();
  // Routes are left unstubbed so this test stays independent of response
  // shapes; the transport records the request before the SDK rejects the 404.
  const context = new CliContext(
    new RecordedOutput(),
    runtime.transport,
    plainStyle,
    async () => ({ url: STORED_URL }),
    env,
  );
  try {
    await buildProgram(context).parseAsync(argv, { from: 'user' });
  } catch {
    // Expected: the address is the assertion, not the response.
  }

  const [first] = runtime.requests;
  if (first === undefined) throw new Error(`${argv.join(' ')} made no request`);
  return first.url;
}

describe('runtime address resolution', () => {
  for (const command of CLIENT_COMMANDS) {
    it(`${command.name} honours ${ENV_RUNTIME_URL}`, async () => {
      const url = await dialledUrl(command.argv, { [ENV_RUNTIME_URL]: ENV_URL });

      // Reading the wrong runtime is silent: it answers, so nothing looks broken.
      expect(url.startsWith(ENV_URL)).toBe(true);
    });

    it(`${command.name} falls back to the runtime setup stored`, async () => {
      const url = await dialledUrl(command.argv, {});

      expect(url.startsWith(STORED_URL)).toBe(true);
    });

    it(`${command.name} lets --url beat both`, async () => {
      const url = await dialledUrl([...command.argv, '--url', FLAG_URL], {
        [ENV_RUNTIME_URL]: ENV_URL,
      });

      expect(url.startsWith(FLAG_URL)).toBe(true);
    });
  }
});
