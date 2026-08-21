import type {
  ActionAdvisor,
  ActionRequest,
  Advisory,
  AdvisoryContext,
} from '@memnox/core';
import { DECISION_EFFECT, normalizeShellCommand } from '@memnox/core';
import { matchesAny } from '@memnox/policy-engine';

export const SHELL_INDIRECTION_ADVISOR = 'shell-indirection';
export const RISK_SIGNAL_HIDDEN_COMMAND = 'hidden-destructive-command';
export const RISK_SIGNAL_OPAQUE_COMMAND = 'opaque-command';

export const SHELL_ACTIONS = ['shell.execute', 'shell.run'];

/** Destructive spellings, matched against canonical form so flags cannot dodge. */
export const DEFAULT_DESTRUCTIVE_PATTERNS: readonly string[] = [
  'rm -f -r *',
  'rm -r *',
  'rm -f *',
  'dd *of=/dev/*',
  'mkfs*',
  '*drop table*',
  '*drop database*',
  '*truncate table*',
  'shred *',
  'chmod * 777 *',
  'chmod 777 *',
];

/** Indirection it cannot resolve is escalated, never assumed harmless. */
export class ShellIndirectionAdvisor implements ActionAdvisor {
  readonly name = SHELL_INDIRECTION_ADVISOR;

  constructor(
    private readonly destructive: readonly string[] = DEFAULT_DESTRUCTIVE_PATTERNS,
    private readonly approvers: string[] = [],
  ) {}

  async advise(request: ActionRequest, _context: AdvisoryContext): Promise<Advisory[]> {
    if (!SHELL_ACTIONS.includes(request.action)) return [];
    const command = request.target;
    if (command === undefined || command.length === 0) return [];

    const { segments, opaque } = normalizeShellCommand(command);

    const hidden = segments.filter((segment) =>
      matchesAny([...this.destructive], segment),
    );
    if (hidden.length > 0) {
      return [
        {
          source: this.name,
          escalateTo: DECISION_EFFECT.BLOCK,
          reason: `destructive command behind indirection: ${hidden[0]}`,
          signals: [RISK_SIGNAL_HIDDEN_COMMAND],
        },
      ];
    }

    // Saying "we could not read this" beats pretending it was safe.
    if (opaque.length > 0) {
      return [
        {
          source: this.name,
          escalateTo: DECISION_EFFECT.REQUIRE_APPROVAL,
          reason: `command could not be fully resolved (${opaque.join(', ')})`,
          signals: [RISK_SIGNAL_OPAQUE_COMMAND],
          approvers: this.approvers,
        },
      ];
    }
    return [];
  }
}
