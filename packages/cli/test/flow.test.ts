import { describe, expect, it } from 'vitest';
import { RecordedOutput } from '../src/cli-output';
import { Flow } from '../src/flow';
import { wordmark } from '../src/banner';
import { ansiStyle, plainStyle } from '../src/style';

const strip = (text: string): string => text.replace(/\[[0-9;]*m/g, '');

function drawn(style: typeof ansiStyle): RecordedOutput {
  const out = new RecordedOutput();
  const flow = new Flow(out, style);
  flow.open('memnox login');
  flow.step('Control plane', 'https://api.memnox.com');
  flow.value('Your code', 'CDFG-HJKM');
  flow.box('Enrolled', ['workspace   ws_acme']);
  flow.close('This machine is enrolled.');
  flow.hint('Take it back off with "memnox logout".');
  return out;
}

describe('the flow rail', () => {
  it('writes every line as commentary, so a pipe receives none of it', () => {
    /* The rail is decoration. `line` is the payload a caller may read and this
       must never put a gutter character in front of it. */
    const out = drawn(ansiStyle);

    expect(out.lines).toEqual([]);
    expect(out.notes.length).toBeGreaterThan(0);
  });

  it('draws the rail, the marker and the label', () => {
    const text = drawn(ansiStyle).notes.map(strip).join('\n');

    expect(text).toContain('◇ Control plane');
    expect(text).toContain('│ https://api.memnox.com');
    expect(text).toContain('└ This machine is enrolled.');
  });

  it('drops the rail entirely in plain mode rather than drawing it in ASCII', () => {
    /* A gutter character on every line of a log file is noise nobody asked for,
       and the labels carry the structure without it. */
    const text = drawn(plainStyle).notes.join('\n');

    expect(text).toContain('Control plane');
    expect(text).toContain('Enrolled');
    for (const mark of ['│', '◇', '┌', '└', '╭', '╰']) {
      expect(text, mark).not.toContain(mark);
    }
  });

  it('says everything in plain mode that it says decorated', () => {
    // The chrome may go; a fact may not.
    const plain = drawn(plainStyle).notes.join('\n');
    for (const said of ['Control plane', 'CDFG-HJKM', 'ws_acme', 'enrolled']) {
      expect(plain, said).toContain(said);
    }
  });
});

describe('the wordmark', () => {
  it('is the plain word when nothing is being drawn', () => {
    // Block characters in a log file are worse than no wordmark at all.
    expect(wordmark(plainStyle, 'memnox')).toEqual(['memnox']);
  });

  it('spells the name in blocks, on one grid, with a ledge under it', () => {
    const lines = wordmark(ansiStyle, 'memnox').map(strip);

    // Five rows of letter and one of shadow; every row the same width.
    expect(lines).toHaveLength(6);
    const widths = new Set(lines.map((line) => line.length));
    expect(widths.size).toBe(1);

    expect(lines.slice(0, 5).every((line) => line.includes('█'))).toBe(true);
    // The ledge is under the word and nowhere inside it.
    expect(lines[5]).not.toContain('█');
    expect(lines[5]).toContain('▄');
    expect(lines.slice(0, 5).some((line) => line.includes('▄'))).toBe(false);
  });

  it('fits a terminal nobody has resized', () => {
    const width = strip(wordmark(ansiStyle, 'memnox')[0] ?? '').length;

    expect(width).toBeLessThanOrEqual(80);
  });
});
