import {
  DECISION_EFFECT,
  RISK_LEVEL,
  type DecisionEffect,
  type RiskLevel,
} from '@memnox/core';

/** Injected, not an ambient check; `plainStyle` is the identity everywhere else. */
export interface Style {
  bold(text: string): string;
  dim(text: string): string;
  /** A run state working as intended — armed, reachable, installed. */
  ok(text: string): string;
  /** A run state worth attention that is not a verdict: observing, waiting, absent. */
  warn(text: string): string;
  /** Colours and prefixes a verdict; plain mode returns the effect unchanged. */
  effect(effect: DecisionEffect | string, text: string): string;
  risk(level: RiskLevel | string, text: string): string;
  /** Marker shown beside a verdict; empty in plain mode. */
  symbol(effect: DecisionEffect | string): string;
}

const ANSI = {
  RESET: '\u001b[0m',
  BOLD: '\u001b[1m',
  DIM: '\u001b[2m',
  RED: '\u001b[31m',
  GREEN: '\u001b[32m',
  YELLOW: '\u001b[33m',
} as const;

const EFFECT_COLOUR: Record<string, string> = {
  [DECISION_EFFECT.ALLOW]: ANSI.GREEN,
  [DECISION_EFFECT.BLOCK]: ANSI.RED,
  [DECISION_EFFECT.REQUIRE_APPROVAL]: ANSI.YELLOW,
};

const RISK_COLOUR: Record<string, string> = {
  [RISK_LEVEL.LOW]: ANSI.DIM,
  [RISK_LEVEL.MEDIUM]: ANSI.YELLOW,
  [RISK_LEVEL.HIGH]: ANSI.RED,
  [RISK_LEVEL.CRITICAL]: `${ANSI.BOLD}${ANSI.RED}`,
};

const EFFECT_SYMBOL: Record<string, string> = {
  [DECISION_EFFECT.ALLOW]: '✓',
  [DECISION_EFFECT.BLOCK]: '✗',
  [DECISION_EFFECT.REQUIRE_APPROVAL]: '●',
};

const UNSTYLED_SYMBOL = '';

/** Piped and redirected output must stay parseable, so nothing is decorated. */
export const plainStyle: Style = {
  bold: (text) => text,
  dim: (text) => text,
  ok: (text) => text,
  warn: (text) => text,
  effect: (_effect, text) => text,
  risk: (_level, text) => text,
  symbol: () => UNSTYLED_SYMBOL,
};

const wrap = (code: string, text: string): string => `${code}${text}${ANSI.RESET}`;

export const ansiStyle: Style = {
  bold: (text) => wrap(ANSI.BOLD, text),
  dim: (text) => wrap(ANSI.DIM, text),
  ok: (text) => wrap(ANSI.GREEN, text),
  warn: (text) => wrap(ANSI.YELLOW, text),
  effect: (effect, text) => {
    const colour = EFFECT_COLOUR[effect];
    return colour === undefined ? text : wrap(colour, text);
  },
  risk: (level, text) => {
    const colour = RISK_COLOUR[level];
    return colour === undefined ? text : wrap(colour, text);
  },
  symbol: (effect) => {
    const symbol = EFFECT_SYMBOL[effect];
    return symbol === undefined ? UNSTYLED_SYMBOL : symbol;
  },
};

/** NO_COLOR, then FORCE_COLOR, then whether anything is attached to the stream. */
export function resolveStyle(env: NodeJS.ProcessEnv, isTty: boolean): Style {
  if (env['NO_COLOR'] !== undefined && env['NO_COLOR'] !== '') return plainStyle;
  if (env['FORCE_COLOR'] !== undefined && env['FORCE_COLOR'] !== '0') return ansiStyle;
  return isTty ? ansiStyle : plainStyle;
}
