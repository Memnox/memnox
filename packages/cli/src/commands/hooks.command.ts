import { homedir } from 'node:os';
import type { Command } from 'commander';
import { ENFORCEMENT_MODE, SEAM_KIND } from '@memnox/core';
import {
  DOCKER_ACTIONS,
  DOCKER_BLIND_SPOTS,
  EGRESS_BLIND_SPOTS,
  EGRESS_CONNECT_ACTION,
  EGRESS_REQUEST_ACTION,
  GIT_BLIND_SPOTS,
  GIT_CREDENTIAL_ACTION,
  HOOK_BLIND_SPOTS,
  HOOK_COVERS,
  SHELL_ACTION,
  SHELL_BLIND_SPOTS,
} from '@memnox/tool-hook';
import type { CliContext } from '../cli-context';
import { DEFAULT_BASE_URL } from '../defaults';
import { HookInstaller, HOOK_MATCHER, HOOK_TIMEOUT_SECONDS } from '../hook-installer';

/**
 * The seam that holds an agent's own tools. The MCP proxy governs what an agent
 * reaches through a server; this governs what it does directly, which is most of
 * what a coding agent does.
 */
export function registerHooksCommand(
  program: Command,
  context: CliContext,
  installer = new HookInstaller(homedir()),
): void {
  const hooks = program
    .command('hooks')
    .description("Govern an agent's own file, shell and network tools");

  hooks
    .command('install')
    .description('Route Read, Write, Edit, Bash and WebFetch through Memnox first')
    .option('--url <url>', `runtime base URL (default: ${DEFAULT_BASE_URL})`)
    .option('--token <token>', 'agent token (default: the one from "memnox setup")')
    .action(async (options: { url?: string; token?: string }) => {
      const report = await installer.install();
      context.out.line(
        report.installed
          ? `Installed the Memnox tool hook (${report.path})`
          : `The Memnox tool hook is already installed (${report.path})`,
      );
      describe(context);
      await declareSeam(context, options);
      context.out.note('');
      context.out.note('→ Restart the agent, then ask it to read a credential file.');
      context.out.note('');
      context.out.note('Four more local seams ship with this, wired by hand:');
      context.out.note('  shell   memnox-shell -- <command>');
      context.out.note('  git     git config --global credential.helper memnox');
      context.out.note('  egress  memnox-egress, then HTTP_PROXY/HTTPS_PROXY at it');
      context.out.note('  docker  memnox-docker, then DOCKER_HOST at its socket');
    });

  hooks
    .command('uninstall')
    .description('Remove the tool hook; every other hook in the file is left alone')
    .action(async () => {
      const removed = await installer.uninstall();
      context.out.line(
        removed
          ? `Removed the Memnox tool hook (${installer.settingsPath})`
          : 'No Memnox tool hook was installed',
      );
    });

  hooks
    .command('status')
    .description('Whether the seam is installed, what it sees, and what it cannot')
    .action(async () => {
      const command = await installer.installedCommand();
      const { out, style } = context;
      if (command === null) {
        // With no fixtures there is no pretty default: not installed is an answer.
        out.line('The Memnox tool hook is not installed.');
        out.note('');
        out.note('→ Install it with: memnox hooks install');
        return;
      }
      out.line(`${style.bold('installed')}  ${installer.settingsPath}`);
      out.line(`${style.bold('runs')}       ${command}`);
      describe(context);
    });
}

/**
 * Declared to the runtime so coverage counts it. A runtime that is not running yet is
 * the ordinary local-first case, not a failed install — the seam governs either way.
 */
async function declareSeam(
  context: CliContext,
  options: { url?: string; token?: string },
): Promise<void> {
  try {
    const { client } = await context.connect(options);
    // All three local seams, each with what it cannot see. An undeclared seam is
    // coverage nobody counted; a seam with no blind spots is a claim nobody believes.
    for (const seam of [
      {
        kind: SEAM_KIND.HOOK,
        covers: [...HOOK_COVERS],
        blindTo: [...HOOK_BLIND_SPOTS],
      },
      {
        kind: SEAM_KIND.SHELL,
        covers: [SHELL_ACTION],
        blindTo: [...SHELL_BLIND_SPOTS],
      },
      {
        kind: SEAM_KIND.GIT,
        covers: [GIT_CREDENTIAL_ACTION],
        blindTo: [...GIT_BLIND_SPOTS],
      },
      {
        kind: SEAM_KIND.EGRESS,
        covers: [EGRESS_REQUEST_ACTION, EGRESS_CONNECT_ACTION],
        blindTo: [...EGRESS_BLIND_SPOTS],
      },
      {
        kind: SEAM_KIND.DOCKER,
        covers: [...DOCKER_ACTIONS],
        blindTo: [...DOCKER_BLIND_SPOTS],
      },
    ]) {
      await client.registerSeam({ ...seam, mode: ENFORCEMENT_MODE.ENFORCE });
    }
    context.out.note('');
    context.out.note('Declared to the runtime — coverage now counts these seams.');
  } catch {
    context.out.note('');
    context.out.note(
      'No runtime answered, so coverage does not know about this seam yet.',
    );
    context.out.note('→ Run "memnox setup", then "memnox hooks install" again.');
  }
}

/** What it sees and what it cannot, printed together — a blind spot nobody reads is one nobody has. */
function describe(context: CliContext): void {
  const { out, style } = context;
  out.line('');
  out.line(`${style.bold('matches')}    ${HOOK_MATCHER.split('|').join(', ')}`);
  out.line(`${style.bold('governs')}    ${HOOK_COVERS.join(', ')}`);
  out.line('');
  out.line(style.bold('BLIND TO'));
  for (const spot of HOOK_BLIND_SPOTS) out.line(`  ${style.dim(spot)}`);
  out.line(
    `  ${style.dim(`any call it cannot answer within ${HOOK_TIMEOUT_SECONDS}s, which the agent then runs ungoverned`)}`,
  );
}
