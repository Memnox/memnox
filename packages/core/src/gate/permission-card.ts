/**
 * The question a person is shown on the terminal when an agent is held, drawn as one card:
 * who wants what, the command as typed, why a rule asked, and a short list to choose from.
 * Pure, so the same card is what a test reads and what a terminal draws.
 */
import { riskLabelFor } from '../notice/action-shape';
import { describeHeldCall, HOLD_ANSWER, type HoldAnswer, type HoldRequest } from './hold';

interface CardChoice {
  answer: HoldAnswer;
  label: string;
  /** Letters that still pick it, for hands that learned the old prompt. */
  keys: readonly string[];
}

interface CardView {
  /** Which choice the arrow is on. */
  selected: number;
  /** Left on the clock, so the person can see a walk-away become a no. */
  remainingMs: number;
  /** Columns the card may take, border included. */
  width: number;
  color: boolean;
  /** True where arrows work; a line prompt asks for a number instead. */
  interactive: boolean;
}

const WIDEST = 92;
const NARROWEST = 40;

export function choicesFor(request: HoldRequest): CardChoice[] {
  const choices: CardChoice[] = [
    { answer: HOLD_ANSWER.ONCE, label: 'Yes, once', keys: ['a', 'y'] },
    {
      answer: HOLD_ANSWER.SESSION,
      label: 'Yes, for the rest of this session',
      keys: ['s'],
    },
  ];
  if (request.command !== undefined) {
    choices.push({
      answer: HOLD_ANSWER.EDIT,
      label: 'Edit the command first',
      keys: ['e'],
    });
  }
  choices.push({ answer: HOLD_ANSWER.DENY, label: 'No', keys: ['d', 'n'] });
  return choices;
}

/** The answer a key picks: a number, or one of the letters beside a choice. */
export function answerForKey(request: HoldRequest, key: string): HoldAnswer | null {
  const choices = choicesFor(request);
  const numbered = Number.parseInt(key, 10);
  if (Number.isInteger(numbered) && numbered >= 1 && numbered <= choices.length) {
    return choices[numbered - 1]?.answer ?? null;
  }
  const letter = key.toLowerCase();
  return choices.find((choice) => choice.keys.includes(letter))?.answer ?? null;
}

/** The card, one string per terminal line. */
export function renderCard(request: HoldRequest, view: CardView): string[] {
  const paint = painter(view.color);
  const inner = Math.max(NARROWEST, Math.min(view.width, WIDEST)) - 4;
  const body = [
    paint.bold(titleOf(request)),
    '',
    ...wrap(request.command ?? describeHeldCall(request), inner - 2).map(
      (line) => `  ${paint.bold(line)}`,
    ),
    ...detailOf(request, inner, paint),
    '',
    paint.bold('Do you want to allow it?'),
    ...choiceLines(request, view, paint),
    '',
    ...footerOf(request, view, inner, paint),
  ];
  return framed(body, inner, paint);
}

function titleOf(request: HoldRequest): string {
  const who = request.agent === '' ? 'An agent' : request.agent;
  const opening = who.charAt(0).toUpperCase() + who.slice(1);
  return `${opening} wants to ${phraseOf(request)}`;
}

const PHRASES: readonly (readonly [string, string])[] = [
  ['filesystem.delete', 'delete files'],
  ['filesystem.write', 'change a file'],
  ['filesystem.read', 'read a file'],
  ['http.', 'reach the network'],
  ['git.push', 'push to a remote'],
  ['git.', 'change the repository'],
  ['mcp.', 'call a tool'],
  ['browser.', 'open a site'],
];

function phraseOf(request: HoldRequest): string {
  const found = PHRASES.find(([prefix]) => request.operation.startsWith(prefix));
  if (found !== undefined) return found[1];
  return request.command === undefined ? request.operation : 'run a command';
}

/** Why a rule asked, what else produced it, and what is at stake, the reason said once. */
function detailOf(request: HoldRequest, inner: number, paint: Painter): string[] {
  const lines: string[] = [];
  if (request.command !== undefined) {
    lines.push(`  ${paint.dim(describeHeldCall(request))}`);
  }
  lines.push('', ...labelled('Why', request.reason, inner, paint));
  for (const each of evidenceOf(request)) {
    lines.push(...labelled(each.label, each.text, inner, paint));
  }
  const risk = riskLabelFor(request.operation);
  if (risk !== null && !request.reason.includes(risk)) {
    lines.push(...labelled('Risk', risk, inner, paint, paint.warn));
  }
  return lines;
}

interface Labelled {
  label: string;
  text: string;
}

/**
 * The evidence lines as a label and a detail, with the reason taken off a rule line that
 * repeats it, since the same sentence twice on one card reads as two reasons.
 */
function evidenceOf(request: HoldRequest): Labelled[] {
  return (request.evidence ?? []).flatMap((line) => {
    const trimmed = line.trim();
    const space = trimmed.search(/\s{2,}/);
    if (space === -1) return trimmed === '' ? [] : [{ label: '', text: trimmed }];
    const label = trimmed.slice(0, space);
    const text = trimmed.slice(space).trim().replace(`: ${request.reason}`, '');
    return [{ label: label.charAt(0).toUpperCase() + label.slice(1), text }];
  });
}

const LABEL_WIDTH = 6;

function labelled(
  label: string,
  text: string,
  inner: number,
  paint: Painter,
  tone: (text: string) => string = (plain) => plain,
): string[] {
  const lines = wrap(text, inner - LABEL_WIDTH);
  return lines.map((line, at) => {
    const head = at === 0 ? label.padEnd(LABEL_WIDTH) : ' '.repeat(LABEL_WIDTH);
    return `${paint.dim(head)}${tone(line)}`;
  });
}

function choiceLines(request: HoldRequest, view: CardView, paint: Painter): string[] {
  return choicesFor(request).map((choice, at) => {
    const text = `${at + 1}. ${choice.label}`;
    if (!view.interactive) return `  ${text}`;
    return at === view.selected ? paint.accent(`❯ ${text}`) : `  ${text}`;
  });
}

function footerOf(
  request: HoldRequest,
  view: CardView,
  inner: number,
  paint: Painter,
): string[] {
  const keys = view.interactive
    ? '↑↓ to choose · enter to confirm · esc to say no'
    : `type 1 to ${choicesFor(request).length} and press enter`;
  const lines = [
    paint.dim(keys),
    paint.dim(`No answer in ${clock(view.remainingMs)} means no.`),
  ];
  if (request.approvalId !== undefined) {
    const elsewhere = `Or answer from anywhere: memnox approve ${request.approvalId}`;
    lines.push(...wrap(elsewhere, inner).map((line) => paint.dim(line)));
  }
  return lines;
}

function clock(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

function framed(body: readonly string[], inner: number, paint: Painter): string[] {
  const label = ' Memnox ';
  const top = `╭─${label}${'─'.repeat(inner + 1 - label.length)}╮`;
  const rows = body.map((line) => {
    const padding = Math.max(0, inner - visibleLength(line));
    return `${paint.accent('│')} ${line}${' '.repeat(padding)} ${paint.accent('│')}`;
  });
  return [paint.accent(top), ...rows, paint.accent(`╰${'─'.repeat(inner + 2)}╯`)];
}

/** Broken on spaces, and a word longer than the line broken where it has to be. */
function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  let current = '';
  for (const word of text.split(/\s+/).filter((each) => each !== '')) {
    for (const piece of chunks(word, width)) {
      if (current === '') current = piece;
      else if (current.length + 1 + piece.length <= width)
        current = `${current} ${piece}`;
      else {
        lines.push(current);
        current = piece;
      }
    }
  }
  return current === '' ? (lines.length === 0 ? [''] : lines) : [...lines, current];
}

function chunks(word: string, width: number): string[] {
  const out: string[] = [];
  for (let at = 0; at < word.length; at += width) out.push(word.slice(at, at + width));
  return out;
}

const ANSI_CODE = /\u001b\[[0-9;?]*[A-Za-z]/g;

function visibleLength(text: string): number {
  return [...text.replace(ANSI_CODE, '')].length;
}

interface Painter {
  bold: (text: string) => string;
  dim: (text: string) => string;
  accent: (text: string) => string;
  warn: (text: string) => string;
}

const RESET = '\u001b[0m';

function painter(color: boolean): Painter {
  const code =
    (open: string) =>
    (text: string): string =>
      color ? `${open}${text}${RESET}` : text;
  return {
    bold: code('\u001b[1m'),
    dim: code('\u001b[2m'),
    // The product's blue, the same the rest of the CLI draws its rail in.
    accent: code('\u001b[38;5;33m'),
    warn: code('\u001b[33m'),
  };
}
