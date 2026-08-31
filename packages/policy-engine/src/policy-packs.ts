import { DECISION_EFFECT } from '@memnox/core';
import type { Policy } from './policy';

/** A pack belongs to exactly one: filed under two, it should have been two packs. */
export const POLICY_SURFACES = [
  {
    id: 'coding-agents',
    label: 'AI coding agents',
    description:
      'Claude Code, Codex, Cursor, and the shell, repository and database work they do.',
  },
  {
    id: 'browser-agents',
    label: 'Browser agents',
    description: 'Agents driving a real browser session, and where they may go.',
  },
  {
    id: 'assistant-agents',
    label: 'Assistant agents',
    description: 'Agents acting on somebody’s real inbox, calendar and accounts.',
  },
  {
    id: 'infrastructure',
    label: 'Infrastructure',
    description: 'Cloud accounts, clusters, CI, and the deploys that change them.',
  },
  {
    id: 'database',
    label: 'Database',
    description:
      'Production data: what may be read, what may be written, what may be dropped.',
  },
  {
    id: 'secrets',
    label: 'Secrets',
    description: 'Credentials, keys, and the authentication code that uses them.',
  },
  {
    id: 'customer-data',
    label: 'Customer data',
    description: 'Customer records, CRM and analytics, and bulk reads of them.',
  },
  {
    id: 'financial',
    label: 'Financial',
    description: 'Money movement, payment code, payouts and treasury operations.',
  },
  {
    id: 'human-oversight',
    label: 'Human oversight',
    description: 'Where an action stops and waits for a person to say yes.',
  },
  {
    id: 'autonomous-workflow',
    label: 'Autonomous workflow',
    description: 'How far unattended work may run, and what it may leave behind it.',
  },
  {
    id: 'multi-agent',
    label: 'Multi-agent',
    description: 'Delegation between agents, and the reach that travels with it.',
  },
  {
    id: 'ai-native-threat',
    label: 'AI-native threat',
    description: 'Attacks on the governance itself: bypass, exfiltration, escalation.',
  },
  {
    id: 'model',
    label: 'Model and providers',
    description: 'Which model families and inference vendors may be used.',
  },
  {
    id: 'jurisdiction',
    label: 'Jurisdiction',
    description: 'Where data may be processed, and which regions may run the work.',
  },
  {
    id: 'regulatory',
    label: 'Regulatory',
    description: 'Evidence and controls for HIPAA, PCI, GDPR and SOC 2.',
  },
] as const;

export type PolicySurface = (typeof POLICY_SURFACES)[number]['id'];

/** `stable` enforces on install; `beta` is narrower or wants a look first. */
export const PACK_MATURITY = {
  STABLE: 'stable',
  BETA: 'beta',
} as const;

export type PackMaturity = (typeof PACK_MATURITY)[keyof typeof PACK_MATURITY];

/** Stated by the pack, so whatever draws it never guesses what it still needs. */
export const PACK_CAVEAT = {
  EDIT: 'edit',
  CLASSIFICATION: 'classification',
} as const;

export type PackCaveat = (typeof PACK_CAVEAT)[keyof typeof PACK_CAVEAT];

export interface PolicyPack {
  name: string;
  /** The title a person reads. `name` stays the id every install path keys on. */
  label: string;
  surface: PolicySurface;
  /** Moves when the rules do, so a control plane can spot a stale installation. */
  version: string;
  maturity: PackMaturity;
  description: string;
  /** Absent means the pack enforces as shipped. */
  caveat?: PackCaveat;
  /** A starting order for a catalogue, not a ranking of importance. */
  recommended?: boolean;
  policies: Policy[];
}

/** Conservative by design: a pack that withholds legitimate work gets uninstalled. */
export const POLICY_PACKS: readonly PolicyPack[] = [
  {
    name: 'production-safety',
    label: 'Production Safety',
    surface: 'infrastructure',
    version: '1.0.0',
    maturity: PACK_MATURITY.STABLE,
    recommended: true,
    description: 'No AI-initiated destruction or deployment in production.',
    policies: [
      {
        name: 'production-database-protection',
        description: 'Destructive database operations in production are never automated.',
        match: {
          actions: ['database.delete', 'database.drop', 'database.truncate'],
          environments: ['production', 'prod'],
        },
        decision: {
          effect: DECISION_EFFECT.WITHHOLD,
          reason: 'No AI-initiated destructive database operations in production.',
        },
      },
      {
        name: 'production-deploy-approval',
        description: 'A human signs off on anything reaching production.',
        match: { actions: ['deploy.*'], environments: ['production', 'prod'] },
        decision: {
          effect: DECISION_EFFECT.ESCALATE,
          reason: 'Production deployments need a human sign-off.',
          approvers: ['eng-lead'],
        },
      },
      {
        name: 'infrastructure-teardown-approval',
        description: 'Destroying infrastructure is not a routine agent action.',
        match: { actions: ['infrastructure.delete', 'infrastructure.destroy'] },
        decision: {
          effect: DECISION_EFFECT.ESCALATE,
          reason: 'Tearing down infrastructure needs a human.',
          approvers: ['platform-team'],
        },
      },
    ],
  },
  {
    name: 'payments',
    label: 'Payment Code Review',
    surface: 'financial',
    version: '1.0.0',
    maturity: PACK_MATURITY.STABLE,
    description: 'Money-handling code changes go through security review.',
    policies: [
      {
        name: 'payment-code-approval',
        match: {
          actions: ['code.modify', 'code.delete', 'file.write'],
          targets: ['*payment*', '*billing*', '*checkout*', '*invoice*'],
        },
        decision: {
          effect: DECISION_EFFECT.ESCALATE,
          reason: 'Payment logic changes need security review.',
          approvers: ['security-team'],
        },
      },
    ],
  },
  {
    name: 'auth-and-secrets',
    label: 'Auth and Secrets',
    surface: 'secrets',
    version: '1.0.0',
    maturity: PACK_MATURITY.STABLE,
    recommended: true,
    description: 'Authentication code and credential files are not edited unattended.',
    policies: [
      {
        name: 'auth-code-approval',
        match: {
          actions: ['code.modify', 'code.delete', 'file.write'],
          targets: ['*auth*', '*session*', '*password*', '*permission*'],
        },
        decision: {
          effect: DECISION_EFFECT.ESCALATE,
          reason: 'Authentication and authorization changes need security review.',
          approvers: ['security-team'],
        },
      },
      {
        name: 'credential-file-protection',
        description: 'Writing a credential file is how secrets reach version control.',
        match: {
          actions: ['file.write'],
          targets: ['*.env', '*.env.*', '*credentials*', '*.pem', '*.key'],
        },
        decision: {
          effect: DECISION_EFFECT.WITHHOLD,
          reason: 'Agents do not write credential files — use a secrets manager.',
        },
      },
    ],
  },
  {
    name: 'data-privacy',
    label: 'Data Privacy',
    surface: 'customer-data',
    version: '1.0.0',
    maturity: PACK_MATURITY.STABLE,
    recommended: true,
    description: 'Bulk data leaving the system is a human decision.',
    policies: [
      {
        name: 'customer-data-export-approval',
        match: { actions: ['data.export', 'database.export'] },
        decision: {
          effect: DECISION_EFFECT.ESCALATE,
          reason: 'Exporting data needs a human owner on the record.',
          approvers: ['data-protection-officer'],
        },
      },
      {
        name: 'pii-table-protection',
        match: {
          actions: ['database.delete', 'database.drop', 'database.export'],
          targets: ['*users*', '*customers*', '*accounts*', '*profiles*'],
        },
        decision: {
          effect: DECISION_EFFECT.ESCALATE,
          reason: 'Operations on personal-data tables need a human.',
          approvers: ['data-protection-officer'],
        },
      },
    ],
  },
  {
    name: 'supply-chain',
    label: 'Supply Chain',
    surface: 'infrastructure',
    version: '1.0.0',
    maturity: PACK_MATURITY.BETA,
    description: 'New third-party code and CI configuration get reviewed.',
    policies: [
      {
        name: 'ci-configuration-approval',
        description: 'CI config is a supply-chain surface — it runs with credentials.',
        match: {
          actions: ['file.write', 'code.modify'],
          targets: ['.github/workflows/*', '*Dockerfile*', '*.gitlab-ci.yml'],
        },
        decision: {
          effect: DECISION_EFFECT.ESCALATE,
          reason: 'CI and build configuration changes need review.',
          approvers: ['platform-team'],
        },
      },
      {
        name: 'shell-execution-approval',
        match: { actions: ['shell.execute'], environments: ['production', 'prod'] },
        decision: {
          effect: DECISION_EFFECT.ESCALATE,
          reason: 'Running shell commands against production needs a human.',
          approvers: ['platform-team'],
        },
      },
    ],
  },
  {
    name: 'repository-protection',
    label: 'Repository Protection',
    surface: 'coding-agents',
    version: '1.0.0',
    maturity: PACK_MATURITY.STABLE,
    recommended: true,
    description: 'Git history is evidence — rewriting it needs a human.',
    policies: [
      {
        name: 'history-rewrite-protection',
        description: 'A force-push can destroy work that exists nowhere else.',
        match: {
          actions: [
            'repository.force_push',
            'repository.reset_hard',
            'repository.rewrite_history',
          ],
        },
        decision: {
          effect: DECISION_EFFECT.WITHHOLD,
          reason: 'Rewriting published git history is never automated.',
        },
      },
      {
        name: 'branch-deletion-approval',
        match: { actions: ['repository.delete_branch', 'repository.delete_remote'] },
        decision: {
          effect: DECISION_EFFECT.ESCALATE,
          reason: 'Deleting a branch or remote needs a human.',
          approvers: ['eng-lead'],
        },
      },
    ],
  },
  {
    name: 'infrastructure',
    label: 'Infrastructure',
    surface: 'infrastructure',
    version: '1.0.0',
    maturity: PACK_MATURITY.STABLE,
    recommended: true,
    description: 'Destructive cloud and cluster operations need a human.',
    policies: [
      {
        name: 'terraform-destroy-protection',
        description: 'A terraform destroy can take an environment down in one call.',
        match: {
          actions: [
            'terraform.destroy',
            'terraform.state_remove',
            'terraform.force_unlock',
          ],
        },
        decision: {
          effect: DECISION_EFFECT.WITHHOLD,
          reason: 'Destroying or unlocking Terraform state is never automated.',
        },
      },
      {
        name: 'kubernetes-disruption-approval',
        match: {
          actions: [
            'kubernetes.delete',
            'kubernetes.drain',
            'kubernetes.scale',
            'kubernetes.rollout_undo',
          ],
        },
        decision: {
          effect: DECISION_EFFECT.ESCALATE,
          reason: 'Disruptive cluster operations need a human.',
          approvers: ['platform-team'],
        },
      },
      {
        name: 'cloud-resource-deletion-approval',
        description: 'Covers the delete verbs across cloud providers.',
        match: {
          actions: [
            'cloud.delete_instance',
            'cloud.delete_database',
            'cloud.delete_bucket',
            'cloud.delete_stack',
            'cloud.delete_secret',
          ],
        },
        decision: {
          effect: DECISION_EFFECT.ESCALATE,
          reason: 'Deleting cloud resources needs a human.',
          approvers: ['platform-team'],
        },
      },
      {
        name: 'iam-change-approval',
        description: 'A privilege change is how a small mistake becomes a large one.',
        match: { actions: ['cloud.modify_iam', 'cloud.attach_policy'] },
        decision: {
          effect: DECISION_EFFECT.ESCALATE,
          reason: 'Changing cloud permissions needs a human.',
          approvers: ['security-team'],
        },
      },
    ],
  },
  {
    name: 'framework-db-reset',
    label: 'Framework DB Reset',
    surface: 'database',
    version: '1.0.0',
    maturity: PACK_MATURITY.STABLE,
    description: 'ORM reset commands drop every table without looking like it.',
    policies: [
      {
        name: 'migration-reset-protection',
        description: 'Reset and fresh verbs recreate the schema from nothing.',
        match: {
          actions: [
            'database.migrate_reset',
            'database.migrate_fresh',
            'database.schema_drop',
            'database.flush',
          ],
        },
        decision: {
          effect: DECISION_EFFECT.ESCALATE,
          reason: 'Resetting the database schema needs a human.',
          approvers: ['eng-lead'],
        },
      },
      {
        name: 'production-migration-reset-block',
        match: {
          actions: ['database.migrate_reset', 'database.migrate_fresh'],
          environments: ['production', 'prod'],
        },
        decision: {
          effect: DECISION_EFFECT.WITHHOLD,
          reason: 'Schema resets never run against production.',
        },
      },
    ],
  },
  {
    name: 'read-only-production',
    label: 'Read-Only Production',
    surface: 'database',
    version: '1.0.0',
    maturity: PACK_MATURITY.STABLE,
    recommended: true,
    description: 'Freezes an environment: reads pass, writes do not.',
    policies: [
      {
        name: 'production-write-freeze',
        description: 'Install this on the environment you want frozen.',
        match: {
          actions: [
            'database.write',
            'database.update',
            'database.insert',
            'database.alter',
          ],
          environments: ['production', 'prod'],
        },
        decision: {
          effect: DECISION_EFFECT.WITHHOLD,
          reason: 'This environment is read-only.',
        },
      },
    ],
  },
  {
    name: 'policy-bypass-protection',
    label: 'Policy Bypass Protection',
    surface: 'ai-native-threat',
    version: '1.0.0',
    maturity: PACK_MATURITY.STABLE,
    recommended: true,
    description: 'An agent must not be able to disable the thing governing it.',
    policies: [
      {
        name: 'governance-config-protection',
        description:
          'Editing the policy file or hook config is how enforcement gets turned off.',
        match: {
          actions: ['file.write', 'file.delete', 'code.modify'],
          targets: [
            'memnox.policies.yaml',
            '.memnox/*',
            '*/.claude/settings.json',
            '*/.claude/hooks/*',
          ],
        },
        decision: {
          effect: DECISION_EFFECT.WITHHOLD,
          reason: 'Governance configuration is not agent-writable.',
        },
      },
    ],
  },
  {
    name: 'agent-delegation',
    label: 'Agent Delegation',
    surface: 'multi-agent',
    version: '1.0.0',
    maturity: PACK_MATURITY.BETA,
    description: 'A spawned subagent inherits reach without inheriting review.',
    policies: [
      {
        name: 'subagent-spawn-approval',
        match: { actions: ['agent.delegate', 'agent.spawn'] },
        decision: {
          effect: DECISION_EFFECT.ESCALATE,
          reason: 'Delegating work to a subagent needs a human.',
          approvers: ['eng-lead'],
        },
      },
    ],
  },
  {
    name: 'terminal-safety',
    label: 'Terminal Safety',
    surface: 'coding-agents',
    version: '1.0.0',
    maturity: PACK_MATURITY.STABLE,
    recommended: true,
    description: 'Shell commands that cannot be undone.',
    policies: [
      {
        name: 'recursive-delete-protection',
        description: 'Matches the command text the caller reports as the target.',
        match: {
          actions: ['shell.execute'],
          targets: ['*rm -rf /*', '*rm -fr /*', '*rm -rf ~*', '*rm -rf .*'],
        },
        decision: {
          effect: DECISION_EFFECT.WITHHOLD,
          reason: 'Recursive force-delete is withheld for agents.',
        },
      },
      {
        name: 'disk-overwrite-protection',
        match: {
          actions: ['shell.execute'],
          targets: ['*mkfs*', '*dd if=*of=/dev/*', '*> /dev/sd*', '*fdisk*'],
        },
        decision: {
          effect: DECISION_EFFECT.WITHHOLD,
          reason: 'Writing raw devices is withheld for agents.',
        },
      },
      {
        name: 'permission-widening-approval',
        description: 'World-writable permissions are almost never the intent.',
        match: {
          actions: ['shell.execute'],
          targets: ['*chmod 777*', '*chmod -R 777*', '*chown -R root*'],
        },
        decision: {
          effect: DECISION_EFFECT.ESCALATE,
          reason: 'Widening permissions needs a human.',
          approvers: ['platform-team'],
        },
      },
    ],
  },
  {
    name: 'human-approval',
    label: 'Human Approval',
    surface: 'human-oversight',
    version: '1.0.0',
    maturity: PACK_MATURITY.STABLE,
    recommended: true,
    description: 'High-stakes actions pause for an operator.',
    policies: [
      {
        name: 'payment-execution-approval',
        match: {
          actions: [
            'payment.charge',
            'payment.transfer',
            'payment.payout',
            'payment.refund',
          ],
        },
        decision: {
          effect: DECISION_EFFECT.ESCALATE,
          reason: 'Moving money needs a human.',
          approvers: ['finance-team'],
        },
      },
      {
        name: 'bulk-send-approval',
        description: 'A bulk send cannot be recalled once it leaves.',
        match: { actions: ['email.send_bulk', 'notification.broadcast'] },
        decision: {
          effect: DECISION_EFFECT.ESCALATE,
          reason: 'Sending to many recipients needs a human.',
          approvers: ['comms-team'],
        },
      },
      {
        name: 'production-data-write-approval',
        match: {
          actions: ['database.write', 'database.update', 'database.insert'],
          environments: ['production', 'prod'],
        },
        decision: {
          effect: DECISION_EFFECT.ESCALATE,
          reason: 'Writing production data needs a human.',
          approvers: ['eng-lead'],
        },
      },
    ],
  },
  {
    name: 'autonomous-persistence',
    label: 'Autonomous Persistence',
    surface: 'autonomous-workflow',
    version: '1.0.0',
    maturity: PACK_MATURITY.BETA,
    description: 'An agent must not arrange to keep acting after the session ends.',
    policies: [
      {
        name: 'scheduled-job-approval',
        match: { actions: ['schedule.create', 'schedule.update'] },
        decision: {
          effect: DECISION_EFFECT.ESCALATE,
          reason: 'Installing a scheduled job needs a human.',
          approvers: ['platform-team'],
        },
      },
      {
        name: 'startup-persistence-approval',
        description:
          'cron, launchd, systemd, and shell profiles all survive the session.',
        match: {
          actions: ['shell.execute', 'file.write'],
          targets: [
            '*crontab*',
            '*/etc/cron*',
            '*launchctl*',
            '*LaunchAgents*',
            '*systemctl enable*',
            '*/etc/systemd/*',
            '*.bashrc',
            '*.zshrc',
            '*.profile',
          ],
        },
        decision: {
          effect: DECISION_EFFECT.ESCALATE,
          reason: 'Unattended persistence needs a human.',
          approvers: ['security-team'],
        },
      },
    ],
  },
  {
    name: 'claude-code',
    label: 'Claude Code',
    surface: 'coding-agents',
    version: '1.0.0',
    maturity: PACK_MATURITY.STABLE,
    description: 'Scoped to the Claude Code agent by name.',
    policies: [
      {
        name: 'claude-code-destructive-shell',
        match: {
          actions: ['shell.execute'],
          agents: ['claude-code', 'claude-code-*'],
          targets: ['*rm -rf*', '*drop table*', '*drop database*'],
        },
        decision: {
          effect: DECISION_EFFECT.WITHHOLD,
          reason: 'Destructive shell is withheld for Claude Code.',
        },
      },
      {
        name: 'claude-code-production-write',
        match: {
          actions: ['database.write', 'database.delete', 'deploy.*'],
          agents: ['claude-code', 'claude-code-*'],
          environments: ['production', 'prod'],
        },
        decision: {
          effect: DECISION_EFFECT.ESCALATE,
          reason: 'Claude Code reaching production needs a human.',
          approvers: ['eng-lead'],
        },
      },
    ],
  },
  {
    name: 'codex',
    label: 'Codex',
    surface: 'coding-agents',
    version: '1.0.0',
    maturity: PACK_MATURITY.STABLE,
    description: 'Scoped to the Codex CLI agent by name.',
    policies: [
      {
        name: 'codex-destructive-shell',
        match: {
          actions: ['shell.execute'],
          agents: ['codex', 'codex-*'],
          targets: ['*rm -rf*', '*drop table*', '*drop database*'],
        },
        decision: {
          effect: DECISION_EFFECT.WITHHOLD,
          reason: 'Destructive shell is withheld for Codex.',
        },
      },
      {
        name: 'codex-production-write',
        match: {
          actions: ['database.write', 'database.delete', 'deploy.*'],
          agents: ['codex', 'codex-*'],
          environments: ['production', 'prod'],
        },
        decision: {
          effect: DECISION_EFFECT.ESCALATE,
          reason: 'Codex reaching production needs a human.',
          approvers: ['eng-lead'],
        },
      },
    ],
  },
  {
    name: 'cursor',
    label: 'Cursor',
    surface: 'coding-agents',
    version: '1.0.0',
    maturity: PACK_MATURITY.STABLE,
    description: 'Scoped to the Cursor agent by name.',
    policies: [
      {
        name: 'cursor-destructive-shell',
        match: {
          actions: ['shell.execute'],
          agents: ['cursor', 'cursor-*'],
          targets: ['*rm -rf*', '*drop table*', '*drop database*'],
        },
        decision: {
          effect: DECISION_EFFECT.WITHHOLD,
          reason: 'Destructive shell is withheld for Cursor.',
        },
      },
      {
        name: 'cursor-production-write',
        match: {
          actions: ['database.write', 'database.delete', 'deploy.*'],
          agents: ['cursor', 'cursor-*'],
          environments: ['production', 'prod'],
        },
        decision: {
          effect: DECISION_EFFECT.ESCALATE,
          reason: 'Cursor reaching production needs a human.',
          approvers: ['eng-lead'],
        },
      },
    ],
  },
  {
    name: 'assistant-agent',
    label: 'Assistant Agent',
    surface: 'assistant-agents',
    version: '1.0.0',
    maturity: PACK_MATURITY.BETA,
    description: 'Personal-assistant agents that act on a real inbox and calendar.',
    policies: [
      {
        name: 'outbound-email-approval',
        description: 'A sent message cannot be recalled.',
        match: { actions: ['email.send', 'email.reply'] },
        decision: {
          effect: DECISION_EFFECT.ESCALATE,
          reason: 'Sending mail on your behalf needs a human.',
          approvers: ['account-owner'],
        },
      },
      {
        name: 'calendar-write-approval',
        match: { actions: ['calendar.create', 'calendar.update', 'calendar.delete'] },
        decision: {
          effect: DECISION_EFFECT.ESCALATE,
          reason: 'Changing your calendar needs a human.',
          approvers: ['account-owner'],
        },
      },
    ],
  },
  {
    name: 'browser-agent',
    label: 'Browser Agent',
    surface: 'browser-agents',
    version: '1.0.0',
    maturity: PACK_MATURITY.BETA,
    description: 'Baseline governance for agents driving a real browser session.',
    policies: [
      {
        name: 'browser-payment-protection',
        description: 'A submitted payment form is a completed purchase.',
        match: {
          actions: ['browser.submit', 'browser.click'],
          targets: ['*checkout*', '*payment*', '*purchase*', '*wire-transfer*'],
        },
        decision: {
          effect: DECISION_EFFECT.WITHHOLD,
          reason: 'Browser agents do not complete purchases.',
        },
      },
      {
        name: 'browser-admin-protection',
        match: {
          actions: ['browser.submit', 'browser.click'],
          targets: ['*/admin*', '*/settings*', '*/account*'],
        },
        decision: {
          effect: DECISION_EFFECT.ESCALATE,
          reason: 'Changing account or admin settings needs a human.',
          approvers: ['account-owner'],
        },
      },
      {
        name: 'browser-export-protection',
        match: { actions: ['browser.download', 'browser.export'] },
        decision: {
          effect: DECISION_EFFECT.ESCALATE,
          reason: 'Downloading data from a browser session needs a human.',
          approvers: ['data-protection-officer'],
        },
      },
    ],
  },
  {
    name: 'aws',
    label: 'AWS',
    surface: 'infrastructure',
    version: '1.0.0',
    maturity: PACK_MATURITY.STABLE,
    description: 'Destructive and privilege-changing AWS operations.',
    policies: [
      {
        name: 'aws-destructive-cli',
        match: {
          actions: ['shell.execute'],
          targets: [
            '*aws * delete-*',
            '*aws * terminate-instances*',
            '*aws s3 rb*',
            '*aws s3 rm*--recursive*',
            '*aws cloudformation delete-stack*',
          ],
        },
        decision: {
          effect: DECISION_EFFECT.WITHHOLD,
          reason: 'Destructive AWS operations are not automated.',
        },
      },
      {
        name: 'aws-iam-change-approval',
        match: {
          actions: ['shell.execute'],
          targets: ['*aws iam *', '*aws sts assume-role*'],
        },
        decision: {
          effect: DECISION_EFFECT.ESCALATE,
          reason: 'Changing AWS permissions needs a human.',
          approvers: ['security-team'],
        },
      },
    ],
  },
  {
    name: 'cloudflare',
    label: 'Cloudflare',
    surface: 'infrastructure',
    version: '1.0.0',
    maturity: PACK_MATURITY.STABLE,
    description: 'Destructive Wrangler operations against Cloudflare resources.',
    policies: [
      {
        name: 'cloudflare-destructive-wrangler',
        match: {
          actions: ['shell.execute'],
          targets: [
            '*wrangler delete*',
            '*wrangler kv:namespace delete*',
            '*wrangler r2 bucket delete*',
            '*wrangler d1 delete*',
            '*wrangler secret delete*',
          ],
        },
        decision: {
          effect: DECISION_EFFECT.WITHHOLD,
          reason: 'Deleting Cloudflare resources is not automated.',
        },
      },
    ],
  },
  {
    name: 'data-egress',
    label: 'Data Egress',
    surface: 'ai-native-threat',
    version: '1.0.0',
    maturity: PACK_MATURITY.BETA,
    description: 'Agent-initiated transfers to destinations you did not approve.',
    policies: [
      {
        name: 'untrusted-egress-protection',
        description: 'Paste and file-drop hosts are how data leaves quietly.',
        match: {
          actions: ['http.request', 'shell.execute'],
          targets: [
            '*file.io*',
            '*pastebin.com*',
            '*transfer.sh*',
            '*webhook.site*',
            '*ngrok.io*',
            '*0x0.st*',
          ],
        },
        decision: {
          effect: DECISION_EFFECT.WITHHOLD,
          reason: 'Transfers to unapproved destinations are withheld.',
        },
      },
      {
        name: 'archive-upload-approval',
        match: {
          actions: ['http.request'],
          targets: ['*.zip', '*.tar.gz', '*.sql', '*.dump'],
        },
        decision: {
          effect: DECISION_EFFECT.ESCALATE,
          reason: 'Uploading an archive or dump needs a human.',
          approvers: ['data-protection-officer'],
        },
      },
    ],
  },
  {
    name: 'model-governance',
    label: 'Model Governance',
    surface: 'model',
    version: '1.0.0',
    maturity: PACK_MATURITY.STABLE,
    recommended: true,
    description:
      'Restricts inference to approved model families. Edit the lists to match your own.',
    caveat: PACK_CAVEAT.EDIT,
    policies: [
      {
        name: 'unapproved-model-block',
        description: 'Deny-by-exception: name the families you allow, block the rest.',
        match: {
          actions: ['llm.infer', 'llm.complete'],
          models: ['*fine-tune*', '*ft:*', '*preview*', '*experimental*', '*uncensored*'],
        },
        decision: {
          effect: DECISION_EFFECT.WITHHOLD,
          reason: 'This model family is not approved for inference.',
        },
      },
    ],
  },
  {
    name: 'provider-governance',
    label: 'Provider Governance',
    surface: 'model',
    version: '1.0.0',
    maturity: PACK_MATURITY.STABLE,
    description: 'Restricts which inference providers and vendors may be used.',
    caveat: PACK_CAVEAT.EDIT,
    policies: [
      {
        name: 'unapproved-provider-approval',
        description:
          'Edit this list to name the providers your organization has reviewed.',
        match: {
          actions: ['llm.infer', 'llm.complete'],
          providers: ['*replicate*', '*together*', '*huggingface*', '*self-hosted*'],
        },
        decision: {
          effect: DECISION_EFFECT.ESCALATE,
          reason: 'Using an unreviewed inference provider needs a human.',
          approvers: ['security-team'],
        },
      },
    ],
  },
  {
    name: 'data-residency',
    label: 'Data Residency',
    surface: 'jurisdiction',
    version: '1.0.0',
    maturity: PACK_MATURITY.BETA,
    description:
      'Keeps classified data in its lawful region. Inert unless requests carry a classification.',
    caveat: PACK_CAVEAT.CLASSIFICATION,
    policies: [
      {
        name: 'eu-pii-residency',
        description: 'GDPR Art. 44 — EU personal data does not leave the EEA.',
        match: {
          actions: ['*'],
          dataClassifications: ['pii.eu', 'gdpr*'],
          jurisdictions: ['us', 'apac', 'global'],
        },
        decision: {
          effect: DECISION_EFFECT.WITHHOLD,
          reason: 'EU personal data may not leave the EEA.',
        },
      },
      {
        name: 'hipaa-us-residency',
        match: {
          actions: ['*'],
          dataClassifications: ['hipaa', 'phi'],
          jurisdictions: ['eu', 'apac', 'global'],
        },
        decision: {
          effect: DECISION_EFFECT.WITHHOLD,
          reason: 'HIPAA data stays in US jurisdiction.',
        },
      },
    ],
  },
  {
    name: 'regulated-data',
    label: 'Regulated Data',
    surface: 'regulatory',
    version: '1.0.0',
    maturity: PACK_MATURITY.BETA,
    description:
      'Human review for regulated categories. Inert unless requests carry a classification.',
    caveat: PACK_CAVEAT.CLASSIFICATION,
    policies: [
      {
        name: 'cardholder-data-approval',
        description: 'PCI DSS — cardholder data is not handled unattended.',
        match: { actions: ['*'], dataClassifications: ['pci', 'cardholder*'] },
        decision: {
          effect: DECISION_EFFECT.ESCALATE,
          reason: 'Cardholder data needs a human on the record.',
          approvers: ['compliance-team'],
        },
      },
      {
        name: 'health-data-approval',
        match: { actions: ['*'], dataClassifications: ['hipaa', 'phi'] },
        decision: {
          effect: DECISION_EFFECT.ESCALATE,
          reason: 'Protected health information needs a human on the record.',
          approvers: ['compliance-team'],
        },
      },
      {
        name: 'regulated-data-export-block',
        description: 'Export is the one verb no approval makes safe for regulated data.',
        match: {
          actions: ['data.export', 'database.export', 'http.request'],
          dataClassifications: ['pci', 'hipaa', 'phi', 'pii.eu'],
        },
        decision: {
          effect: DECISION_EFFECT.WITHHOLD,
          reason: 'Regulated data is not exported by an agent.',
        },
      },
    ],
  },
  {
    name: 'sovereignty',
    label: 'Sovereignty',
    surface: 'jurisdiction',
    version: '1.0.0',
    maturity: PACK_MATURITY.BETA,
    description: 'Isolates government and sovereign workloads to approved regions.',
    caveat: PACK_CAVEAT.CLASSIFICATION,
    policies: [
      {
        name: 'sovereign-workload-isolation',
        match: {
          actions: ['*'],
          dataClassifications: ['classified', 'sovereign', 'itar', 'cui'],
          jurisdictions: ['global', 'apac', 'eu'],
        },
        decision: {
          effect: DECISION_EFFECT.WITHHOLD,
          reason: 'Sovereign workloads do not leave their approved region.',
        },
      },
    ],
  },
  {
    name: 'customer-data',
    label: 'Customer Data',
    surface: 'customer-data',
    version: '1.0.0',
    maturity: PACK_MATURITY.STABLE,
    recommended: true,
    description: 'Customer records, CRM, and analytics are not read or shared in bulk.',
    policies: [
      {
        name: 'crm-bulk-read-approval',
        match: {
          actions: ['crm.export', 'crm.bulk_read', 'analytics.export'],
        },
        decision: {
          effect: DECISION_EFFECT.ESCALATE,
          reason: 'Bulk customer data access needs a human.',
          approvers: ['data-protection-officer'],
        },
      },
      {
        name: 'customer-record-sharing-block',
        match: {
          actions: ['crm.share', 'data.share'],
          targets: ['*customer*', '*contact*', '*lead*'],
        },
        decision: {
          effect: DECISION_EFFECT.WITHHOLD,
          reason: 'Customer records are not shared by an agent.',
        },
      },
    ],
  },
  {
    name: 'money-movement',
    label: 'Money Movement',
    surface: 'financial',
    version: '1.0.0',
    maturity: PACK_MATURITY.STABLE,
    recommended: true,
    description: 'Transfers, payouts, refunds, and treasury operations.',
    policies: [
      {
        name: 'treasury-operation-block',
        description: 'Treasury and stablecoin movement is not an agent action at all.',
        match: {
          actions: ['treasury.transfer', 'treasury.withdraw', 'wallet.send'],
        },
        decision: {
          effect: DECISION_EFFECT.WITHHOLD,
          reason: 'Treasury operations are never automated.',
        },
      },
      {
        name: 'refund-issuance-approval',
        match: { actions: ['payment.refund', 'billing.credit'] },
        decision: {
          effect: DECISION_EFFECT.ESCALATE,
          reason: 'Issuing a refund needs a human.',
          approvers: ['finance-team'],
        },
      },
      {
        name: 'billing-change-approval',
        match: {
          actions: ['billing.update', 'subscription.update', 'subscription.cancel'],
        },
        decision: {
          effect: DECISION_EFFECT.ESCALATE,
          reason: 'Changing billing or a subscription needs a human.',
          approvers: ['finance-team'],
        },
      },
    ],
  },
  {
    name: 'agent-chain',
    label: 'Agent Chain',
    surface: 'multi-agent',
    version: '1.0.0',
    maturity: PACK_MATURITY.BETA,
    description: 'Privilege escalation and message passing across agent chains.',
    policies: [
      {
        name: 'tool-escalation-block',
        description: 'An agent asking for more reach than it was granted is the signal.',
        match: {
          actions: ['agent.grant_capability', 'agent.elevate', 'agent.assume_role'],
        },
        decision: {
          effect: DECISION_EFFECT.WITHHOLD,
          reason: 'Agents do not escalate their own privileges.',
        },
      },
      {
        name: 'inter-agent-message-approval',
        match: { actions: ['agent.message', 'agent.broadcast'] },
        decision: {
          effect: DECISION_EFFECT.ESCALATE,
          reason: 'Agent-to-agent messaging needs a human in high-assurance setups.',
          approvers: ['security-team'],
        },
      },
    ],
  },
  {
    name: 'workflow-autonomy',
    label: 'Workflow Autonomy',
    surface: 'autonomous-workflow',
    version: '1.0.0',
    maturity: PACK_MATURITY.BETA,
    description: 'Limits how far an unattended multi-step workflow may go.',
    policies: [
      {
        name: 'chained-destructive-action-block',
        match: {
          actions: ['workflow.chain', 'workflow.autorun'],
          targets: ['*delete*', '*destroy*', '*drop*', '*purge*'],
        },
        decision: {
          effect: DECISION_EFFECT.WITHHOLD,
          reason: 'Destructive steps do not run inside an unattended chain.',
        },
      },
      {
        name: 'long-running-workflow-approval',
        match: { actions: ['workflow.start_unattended', 'workflow.extend'] },
        decision: {
          effect: DECISION_EFFECT.ESCALATE,
          reason: 'Starting or extending unattended automation needs a human.',
          approvers: ['platform-team'],
        },
      },
    ],
  },
  {
    name: 'browser-domains',
    label: 'Browser Domains',
    surface: 'browser-agents',
    version: '1.0.0',
    maturity: PACK_MATURITY.BETA,
    description: 'Where a browser agent may go. Replace the list with your own.',
    caveat: PACK_CAVEAT.EDIT,
    policies: [
      {
        name: 'browser-domain-denylist',
        match: {
          actions: ['browser.navigate', 'browser.click'],
          targets: [
            '*webmail*',
            '*mail.google.com*',
            '*console.aws.amazon.com*',
            '*github.com/settings*',
          ],
        },
        decision: {
          effect: DECISION_EFFECT.ESCALATE,
          reason: 'This destination is outside the browser agent’s normal range.',
          approvers: ['account-owner'],
        },
      },
    ],
  },
  {
    name: 'executive-approval',
    label: 'Executive Approval',
    surface: 'human-oversight',
    version: '1.0.0',
    maturity: PACK_MATURITY.STABLE,
    description: 'The highest-risk actions need more than one signature.',
    policies: [
      {
        name: 'executive-signoff',
        description:
          'Quorum, not a single approver — one compromised account is not enough.',
        match: {
          actions: [
            'treasury.transfer',
            'infrastructure.destroy',
            'database.drop',
            'agent.grant_capability',
          ],
          environments: ['production', 'prod'],
        },
        decision: {
          effect: DECISION_EFFECT.ESCALATE,
          reason: 'This action needs executive sign-off from two people.',
          approvers: ['cto', 'ciso', 'cfo'],
          minApprovals: 2,
        },
      },
    ],
  },
];

export function findPolicyPack(name: string): PolicyPack | null {
  return POLICY_PACKS.find((pack) => pack.name === name) ?? null;
}

/** Names already present win — installing a pack never redefines a team's own rule. */
export function mergePolicies(
  existing: readonly Policy[],
  incoming: readonly Policy[],
): { policies: Policy[]; added: string[]; skipped: string[] } {
  const taken = new Set(existing.map((policy) => policy.name));
  const added: string[] = [];
  const skipped: string[] = [];
  const policies = [...existing];

  for (const policy of incoming) {
    if (taken.has(policy.name)) {
      skipped.push(policy.name);
      continue;
    }
    taken.add(policy.name);
    policies.push(policy);
    added.push(policy.name);
  }
  return { policies, added, skipped };
}
