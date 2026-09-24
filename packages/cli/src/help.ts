/**
 * What `memnox --help` shows: the few commands a person types at a terminal, because the
 * rest happens in the agent session. `memnox help --all` lists every one, all still wired.
 */
import { Help, type Command } from 'commander';

export const HELP_COMMAND = 'help';

/** Said under the short list, so nobody concludes a command they read about is gone. */
export const SHORT_HELP_FOOTER =
  '\nEverything else happens in your agent session; "memnox help --all" lists every command.\n';

interface HelpOptions {
  all?: boolean;
}

/** The short list in the order given, and `help [command] [--all]` in place of commander's own. */
export function configureShortHelp(program: Command, short: readonly string[]): void {
  const shown = { all: false };
  program.configureHelp({
    visibleCommands(command) {
      const every = Help.prototype.visibleCommands.call(this, command);
      // Only the top level: a subcommand list is already short enough to read.
      if (command !== program || shown.all) return every;
      return every
        .filter((each) => short.includes(each.name()))
        .sort((a, b) => short.indexOf(a.name()) - short.indexOf(b.name()));
    },
  });
  program.addHelpText('after', () => (shown.all ? '' : SHORT_HELP_FOOTER));
  program.helpCommand(false);
  program
    .command(`${HELP_COMMAND} [command]`)
    .description('What one command does; --all lists every command')
    .option('--all', 'every command, not only the ones typed at a terminal')
    .action((name: string | undefined, options: HelpOptions) => {
      const found = program.commands.find((each) => each.name() === name);
      if (found !== undefined && found.name() !== HELP_COMMAND) return found.outputHelp();
      // A word that names no command gets the whole list, which is where it would have been.
      shown.all = options.all === true || name !== undefined;
      program.outputHelp();
    });
}
