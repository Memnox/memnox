import {
  DECISION_EFFECT,
  RISK_LEVEL,
  type DecisionEffect,
  type RiskLevel,
} from '@memnox/core';

/** Injected, not an ambient check; `plainStyle` is the identity everywhere else. */
export interface Style {
  /**
   * Whether this style draws anything at all.
   *
   * Asked rather than inferred. The banner and the flow rail have to know: in
   * plain mode they are not "the same output without colour" but a different
   * shape entirely — a word instead of a wordmark, no rail at all — and probing
   * for it by checking whether `bold('x')` came back changed is a test that
   * reads as a trick the next time somebody meets it.
   */
  readonly decorated: boolean;
  bold(text: string): string;
  dim(text: string): string;
  /** A run state working as intended — armed, reachable, installed. */
  ok(text: string): string;
  /** A run state worth attention that is not a verdict: observing, waiting, absent. */
  warn(text: string): string;
  /** The product's own colour, for the rail and the wordmark. */
  accent(text: string): string;
  /** A label on a filled block, the way the flow names what is running. */
  chip(text: string): string;
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
  /* 256-colour, because the brand blue (#1e86ee) has no basic-ANSI neighbour
     worth the name. Every terminal that reports itself as a TTY has supported
     this depth for a decade, and the ones that do not are already covered:
     `NO_COLOR` and a redirected stream both land on `plainStyle`. */
  BRAND: '\u001b[38;5;33m',
  BRAND_FILL: '\u001b[48;5;33m\u001b[38;5;231m',
} as const;

const EFFECT_COLOUR: Record<string, string> = {
  [DECISION_EFFECT.ALLOW]: ANSI.GREEN,
  [DECISION_EFFECT.DENY]: ANSI.RED,
  [DECISION_EFFECT.ASK]: ANSI.YELLOW,
};

const RISK_COLOUR: Record<string, string> = {
  [RISK_LEVEL.LOW]: ANSI.DIM,
  [RISK_LEVEL.MEDIUM]: ANSI.YELLOW,
  [RISK_LEVEL.HIGH]: ANSI.RED,
  [RISK_LEVEL.CRITICAL]: `${ANSI.BOLD}${ANSI.RED}`,
};

const EFFECT_SYMBOL: Record<string, string> = {
  [DECISION_EFFECT.ALLOW]: '✓',
  [DECISION_EFFECT.DENY]: '✗',
  [DECISION_EFFECT.ASK]: '●',
};

const UNSTYLED_SYMBOL = '';

/** Piped and redirected output must stay parseable, so nothing is decorated. */
export const plainStyle: Style = {
  decorated: false,
  bold: (text) => text,
  dim: (text) => text,
  ok: (text) => text,
  warn: (text) => text,
  accent: (text) => text,
  chip: (text) => text,
  effect: (_effect, text) => text,
  risk: (_level, text) => text,
  symbol: () => UNSTYLED_SYMBOL,
};

const wrap = (code: string, text: string): string => `${code}${text}${ANSI.RESET}`;

export const ansiStyle: Style = {
  decorated: true,
  bold: (text) => wrap(ANSI.BOLD, text),
  dim: (text) => wrap(ANSI.DIM, text),
  ok: (text) => wrap(ANSI.GREEN, text),
  warn: (text) => wrap(ANSI.YELLOW, text),
  accent: (text) => wrap(ANSI.BRAND, text),
  // Padded inside the fill, or the label sits flush against the block's edge.
  chip: (text) => wrap(ANSI.BRAND_FILL, ` ${text} `),
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
