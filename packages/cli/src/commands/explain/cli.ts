/** One authenticated or installed CLI: its credential, its projects, and its verb table. */

import { hasTag, VERB_TAG, verbTableFor } from '@memnox/core';
import type { AuthenticatedCli, DiscoveryReport, VerbTable } from '@memnox/core';
import { TOOL_EFFECT } from '@memnox/core';

import type { CliContext } from '../../cli-context';
import type { FlowRow } from '../../flow';
import type { Style } from '../../style';

/** An authenticated CLI, or one that is merely installed and so has no credential. */
export type ExplainedCli =
  | AuthenticatedCli
  | {
      name: string;
      /** The path that proved it is here. An installed CLI has this and no credential. */
      detectedFrom: string;
      via?: undefined;
      detail?: undefined;
      productionLooking?: undefined;
    };

/** The verb table shown is the one enforcement reads, so this promises exactly what `protect` gates. */
export function renderCli(
  context: CliContext,
  cli: ExplainedCli,
  report: DiscoveryReport,
  asJson: boolean,
): void {
  // Cast is safe: `explain` only resolves a CLI whose name the verb tables know.
  const table = verbTableFor(cli.name) as VerbTable;
  if (asJson) {
    context.out.json({ cli, verbs: table.verbs });
    return;
  }

  const { flow, style } = context;
  const kind = cli.via === undefined ? 'an installed CLI' : 'an authenticated CLI';
  flow.rows(`${cli.name}, ${kind}`, cliRows(cli, report, style));
  flow.table('What it can do', ['Verb', 'Class'], verbRows(table, style));
  flow.close(`${table.verbs.length} verb(s) the gate recognises for ${cli.name}.`);
  flow.hint(
    `memnox protect --for ${cli.name}   put the dangerous ones behind ask or deny`,
  );
}

function cliRows(cli: ExplainedCli, report: DiscoveryReport, style: Style): FlowRow[] {
  const agents = report.agents.map((agent) => agent.kind);
  const rows: FlowRow[] = [
    {
      label: 'reachable by',
      value: agents.length === 0 ? 'no agent here' : agents.join(', '),
    },
    // Nothing logged in is not nothing reachable: a credential can arrive tomorrow.
    {
      label: 'credential',
      value:
        cli.via ?? 'none found here, so the table below is what it could do with one',
    },
  ];
  if (cli.detail !== undefined) rows.push({ label: '', value: cli.detail });
  // A guess from a name stays a guess all the way into the screen.
  if (cli.productionLooking !== undefined) {
    rows.push({
      label: '',
      value: style.warn(`"${cli.productionLooking}" is named like production`),
    });
  }
  return rows;
}

/** One row per verb, plus a dimmed row under it for its note. */
function verbRows(table: VerbTable, style: Style): string[][] {
  return table.verbs.flatMap((verb) => {
    const tags = [
      verb.class,
      ...(hasTag(verb, VERB_TAG.PRODUCTION) ? ['production'] : []),
      ...(hasTag(verb, VERB_TAG.SECRETS) ? ['secrets'] : []),
    ].join(' · ');
    const marked =
      verb.class === TOOL_EFFECT.DESTRUCTIVE ? style.warn(tags) : style.dim(tags);
    return [
      [verb.match, marked],
      ...(verb.note === undefined ? [] : [['', style.dim(verb.note)]]),
    ];
  });
}
