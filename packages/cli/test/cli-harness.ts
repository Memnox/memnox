import { Command } from 'commander';
import type { HttpTransport } from '@memnox/sdk';
import { CliContext } from '../src/cli-context';
import { RecordedOutput } from '../src/cli-output';
import { plainStyle } from '../src/style';
import { buildProgram } from '../src/program';

interface RecordedRequest {
  method: string;
  path: string;
  /** Full URL, so a test can prove --url actually reached the client. */
  url: string;
  body: unknown;
  authorization?: string;
}

/** Stands in for a running runtime so command bodies execute against real SDK code. */
export class FakeRuntime {
  readonly requests: RecordedRequest[] = [];
  private readonly routes = new Map<string, { status: number; body: unknown }>();

  on(method: string, path: string, body: unknown, status = 200): this {
    this.routes.set(`${method} ${path}`, { status, body });
    return this;
  }

  get transport(): HttpTransport {
    return async (url, init) => {
      const { pathname } = new URL(url);
      this.requests.push({
        method: init.method,
        path: pathname,
        url,
        body: init.body === undefined ? undefined : JSON.parse(init.body),
        authorization: init.headers['authorization'],
      });

      const route = this.routes.get(`${init.method} ${pathname}`);
      if (!route) {
        return new Response(`no stub for ${init.method} ${pathname}`, { status: 404 });
      }
      return new Response(JSON.stringify(route.body), {
        status: route.status,
        headers: { 'content-type': 'application/json' },
      });
    };
  }
}

/** Tests never read $HOME: stored credentials and environment are supplied here. */
function testContext(out: RecordedOutput, runtime: FakeRuntime): CliContext {
  return new CliContext(out, runtime.transport, plainStyle, async () => ({}), {});
}

interface CliRun {
  out: RecordedOutput;
  runtime: FakeRuntime;
}

/** Parses `args` through the real command tree and returns what it wrote. */
export async function runCli(
  args: string[],
  runtime = new FakeRuntime(),
): Promise<CliRun> {
  const out = new RecordedOutput();
  const program = buildProgram(testContext(out, runtime));
  await program.parseAsync(args, { from: 'user' });
  return { out, runtime };
}

/** For commands whose collaborator would otherwise spawn a process or open a socket. */
export async function runCommand(
  register: (program: Command, context: CliContext) => void,
  args: string[],
  runtime = new FakeRuntime(),
): Promise<CliRun> {
  const out = new RecordedOutput();
  const program = new Command();
  register(program, testContext(out, runtime));
  await program.parseAsync(args, { from: 'user' });
  return { out, runtime };
}
