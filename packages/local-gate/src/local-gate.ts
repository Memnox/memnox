import type { ActionRequest, DecisionEffect, MatchedPolicy } from '@memnox/core';
import { DECISION_EFFECT, EFFECT_PRECEDENCE } from '@memnox/core';
import { isBlocking, redactSecrets, scanContent } from '@memnox/content-shield';
import { PolicyEngine, type Policy } from '@memnox/policy-engine';
import { loadPolicyFiles } from './policy-file';

/** What the gate does when an argument carries a secret, whatever policy said. */
export const SECRET_RESPONSE = {
  BLOCK: 'block',
  REDACT: 'redact',
  /** Report it and let the call through — for rolling the scanner out. */
  SIGNAL: 'signal',
} as const;

export type SecretResponse = (typeof SECRET_RESPONSE)[keyof typeof SECRET_RESPONSE];

export const DEFAULT_SECRET_RESPONSE: SecretResponse = SECRET_RESPONSE.BLOCK;

/**
 * Arguments are not files, and the scanner classifies by path — so they scan
 * under one fixed name. An argument called "notes.md" must not route itself
 * into the sample-file rules and mute its own findings.
 */
const ARGUMENT_SCAN_PATH = 'memnox-argument';
const SIGNAL_SHIELD_PREFIX = 'shield:';
const SIGNAL_POLICY_PREFIX = 'policy:';

export interface LocalGateOptions {
  /** Matched against a rule's `agents` patterns, exactly as the runtime does. */
  agentName: string;
  /** Effect when no rule matches. Defaults to allow — the runtime is still asked. */
  defaultEffect?: DecisionEffect;
  onSecret?: SecretResponse;
  /** Supplied by the caller so a verdict stays reproducible on replay. */
  now?: Date;
}

export interface LocalVerdict {
  effect: DecisionEffect;
  reason: string;
  /** Findings safe to send onward — rule ids only, never the matched text. */
  signals: string[];
  matchedPolicies: MatchedPolicy[];
  /** Set when the effect is redact: the arguments to forward instead of the originals. */
  redactedArguments?: Record<string, string>;
  /** What a monitored rule would have decided, had it been enforcing. */
  withheldEffect?: DecisionEffect;
}

/**
 * Policy evaluated in the process that makes the call. It exists for the two
 * things that must never travel: the call's own arguments and the content it
 * carries. Both are matched and scanned here; only rule ids and signals leave.
 *
 * It does not replace the runtime — it runs before it, and the strictest of the
 * two verdicts is what the enforcement point applies. Rate limits are the
 * runtime's alone: a per-process counter is not a limit.
 */
export class LocalGate {
  private readonly engine: PolicyEngine;
  private readonly onSecret: SecretResponse;

  constructor(
    policies: readonly Policy[],
    private readonly options: LocalGateOptions,
  ) {
    this.engine = new PolicyEngine([...policies], {
      defaultEffect: options.defaultEffect ?? DECISION_EFFECT.ALLOW,
    });
    this.onSecret = options.onSecret ?? DEFAULT_SECRET_RESPONSE;
  }

  /** Loads the same policy files the runtime reads, from this machine's disk. */
  static async fromFiles(
    filePaths: readonly string[],
    options: LocalGateOptions,
  ): Promise<LocalGate> {
    return new LocalGate(await loadPolicyFiles(filePaths), options);
  }

  /** The rule set in force locally — for `memnox policy` style reporting. */
  rules(): Policy[] {
    return this.engine.rules();
  }

  evaluate(request: ActionRequest): LocalVerdict {
    const evaluation = this.engine.evaluate(request, {
      agentName: this.options.agentName,
      now: this.options.now ?? new Date(),
    });
    const policySignals = evaluation.matchedPolicies.map(
      (policy) => `${SIGNAL_POLICY_PREFIX}${policy.name}`,
    );
    const scan = scanArguments(request.arguments);
    const signals = [...policySignals, ...scan.signals];

    const base: LocalVerdict = {
      effect: evaluation.effect,
      reason: evaluation.reason,
      signals,
      matchedPolicies: evaluation.matchedPolicies,
      ...(evaluation.withheldEffect === undefined
        ? {}
        : { withheldEffect: evaluation.withheldEffect }),
    };

    const withSecrets = this.applySecretResponse(base, request, scan);
    if (withSecrets.effect !== DECISION_EFFECT.REDACT) return withSecrets;
    return this.redact(withSecrets, request);
  }

  /**
   * A secret in an argument is the scanner's verdict, not a rule's, so it can
   * only tighten what policy already said — never loosen it.
   */
  private applySecretResponse(
    verdict: LocalVerdict,
    request: ActionRequest,
    scan: ArgumentScan,
  ): LocalVerdict {
    if (!scan.blocking) return verdict;
    if (this.onSecret === SECRET_RESPONSE.SIGNAL) return verdict;

    const escalation =
      this.onSecret === SECRET_RESPONSE.REDACT
        ? DECISION_EFFECT.REDACT
        : DECISION_EFFECT.BLOCK;
    if (EFFECT_PRECEDENCE[escalation] <= EFFECT_PRECEDENCE[verdict.effect]) {
      return verdict;
    }
    return {
      ...verdict,
      effect: escalation,
      reason: `${scan.worst} in argument "${scan.argument}" of ${request.action}`,
    };
  }

  /**
   * Masking is only an outcome if it works: whatever the scanner still finds in
   * the masked text would go out in the clear, so the call is blocked instead.
   */
  private redact(verdict: LocalVerdict, request: ActionRequest): LocalVerdict {
    const supplied = request.arguments;
    if (supplied === undefined) return verdict;

    const masked: Record<string, string> = {};
    const rules = new Set<string>();
    for (const [name, value] of Object.entries(supplied)) {
      const result = redactSecrets(value);
      masked[name] = result.text;
      for (const redaction of result.redactions) rules.add(redaction.rule);
    }

    const remaining = scanArguments(masked);
    if (remaining.blocking) {
      return {
        ...verdict,
        effect: DECISION_EFFECT.BLOCK,
        reason: `${remaining.worst} in argument "${remaining.argument}" cannot be masked safely`,
      };
    }
    return {
      ...verdict,
      redactedArguments: masked,
      signals: [...verdict.signals, ...[...rules].map(redactionSignal)],
    };
  }
}

interface ArgumentScan {
  signals: string[];
  blocking: boolean;
  /** The finding that decided the outcome, named without quoting the secret. */
  worst: string;
  argument: string;
}

function scanArguments(values: Record<string, string> | undefined): ArgumentScan {
  const scan: ArgumentScan = { signals: [], blocking: false, worst: '', argument: '' };
  if (values === undefined) return scan;

  const signals = new Set<string>();
  for (const [name, value] of Object.entries(values)) {
    for (const finding of scanContent(ARGUMENT_SCAN_PATH, value)) {
      signals.add(`${SIGNAL_SHIELD_PREFIX}${finding.rule}`);
      if (!isBlocking(finding) || scan.blocking) continue;
      scan.blocking = true;
      scan.worst = finding.message;
      scan.argument = name;
    }
  }
  scan.signals = [...signals];
  return scan;
}

function redactionSignal(rule: string): string {
  return `${SIGNAL_SHIELD_PREFIX}${rule}`;
}
