import { describe, expect, it } from 'vitest';
import { RecordedOutput } from '../src/cli-output';
import { Flow, TONE } from '../src/flow';
import { wordmark } from '../src/banner';
import { ansiStyle, plainStyle } from '../src/style';

const strip = (text: string): string => text.replace(/\u001b\[[0-9;]*m/g, '');

function drawn(
  style: typeof ansiStyle,
  commentary = false,
): { out: RecordedOutput; flow: Flow } {
  const out = new RecordedOutput();
  const flow = new Flow(out, style);
  flow.open('memnox login');
  if (commentary) flow.commentary();
  flow.step('Control plane', 'https://api.memnox.com');
  flow.value('Your code', 'CDFG-HJKM');
  flow.rows('Enrolled', [{ label: 'workspace', value: 'ws_acme' }]);
  flow.close('This machine is enrolled.');
  flow.hint('Take it back off with "memnox logout".');
  return { out, flow };
}

describe('the flow rail', () => {
  it('is the answer by default, so a redirected run is not an empty file', () => {
    /* `memnox doctor > report.txt` has to hold the report. Only a command whose
       answer is something else moves the rail out of the way. */
    const { out } = drawn(ansiStyle);

    expect(out.notes).toEqual([]);
    expect(out.lines.length).toBeGreaterThan(0);
  });

  it('moves to stderr for a run that prints a payload of its own', () => {
    // `login` answers with a machine id, and a pipe must receive that alone.
    const { out } = drawn(ansiStyle, true);

    expect(out.lines).toEqual([]);
    expect(out.notes.length).toBeGreaterThan(0);
  });

  it('draws the rail, the marker and the label', () => {
    const text = drawn(ansiStyle).out.lines.map(strip).join('\n');

    expect(text).toContain('◇ Control plane');
    expect(text).toContain('│ https://api.memnox.com');
    expect(text).toContain('└ This machine is enrolled.');
  });

  it('draws nothing at all until a rail is opened, which is how --json stays clean', () => {
    /* A command under `--json` never opens one, so every step below it is a
       no-op rather than a flag threaded through thirty call sites. */
    const out = new RecordedOutput();
    const flow = new Flow(out, ansiStyle);

    flow.step('Control plane', 'https://api.memnox.com');
    flow.close('done');

    expect(out.lines).toEqual([]);
    expect(out.notes).toEqual([]);
    expect(flow.drawing).toBe(false);
  });

  it('draws the header on first use, not on open', () => {
    // A command that opens a rail and then answers `--json` leaves no stub.
    const out = new RecordedOutput();
    const flow = new Flow(out, ansiStyle);

    flow.open('memnox config get');
    expect(out.lines).toEqual([]);

    flow.step('Anything');
    expect(strip(out.lines[0] ?? '')).toContain('memnox config get');
  });

  it('terminates a rail the command left open', () => {
    const out = new RecordedOutput();
    const flow = new Flow(out, ansiStyle);
    flow.open('memnox doctor');
    flow.step('Something happened');

    flow.end();

    expect(strip(out.lines.join('\n'))).toContain('└');
  });

  it('says a refusal on stderr, attached to the rail wherever it is drawn', () => {
    // The reason is what a script reads, and a redirected run must still show it.
    const out = new RecordedOutput();
    const flow = new Flow(out, ansiStyle);
    flow.open('memnox lock');
    flow.step('Trying');

    flow.fail('that path is held by somebody else');

    expect(out.notes.join('\n')).toContain('that path is held by somebody else');
    expect(out.lines.join('\n')).not.toContain('held by somebody else');
  });

  it('puts the whole rail on stderr when a refusal is all there was', () => {
    /* A chip on stdout above a reason on stderr leaves a stub in whatever the
       run was redirected into, and the reason nowhere near it. */
    const out = new RecordedOutput();
    const flow = new Flow(out, ansiStyle);
    flow.open('memnox lock');

    flow.fail('No lease bogus.');

    expect(out.lines).toEqual([]);
    expect(strip(out.notes.join('\n'))).toContain('memnox lock');
    expect(out.notes.join('\n')).toContain('No lease bogus.');
  });

  it('aligns a table on its own widest cell, not on the colours', () => {
    const out = new RecordedOutput();
    const flow = new Flow(out, plainStyle);
    flow.open('memnox agents list');

    flow.table(
      'On this machine',
      ['Agent', 'Working'],
      [
        ['a-very-long-agent-name', 'working'],
        ['short', 'waiting'],
      ],
    );

    const rows = out.lines.filter(
      (line) => line.includes('working') || line.includes('waiting'),
    );
    const columns = rows.map((line) => line.search(/work|wait/));
    expect(new Set(columns).size).toBe(1);
  });

  it('measures a column on what a reader can see, not on what the string holds', () => {
    // A coloured cell padded by length leaves every column after it ragged.
    const out = new RecordedOutput();
    const flow = new Flow(out, ansiStyle);
    flow.open('memnox timeline');

    flow.table(
      'Actions',
      ['Verdict', 'Action'],
      [
        [ansiStyle.warn('deny'), 'git.push-force'],
        [ansiStyle.ok('allow'), 'git.commit'],
      ],
    );

    const rows = out.lines.map(strip).filter((line) => line.includes('git.'));
    expect(new Set(rows.map((line) => line.indexOf('git.'))).size).toBe(1);
  });

  it('marks a list row by what it means, so a paste keeps the meaning', () => {
    // Colour does not survive a paste into an issue; the marker does.
    const out = new RecordedOutput();
    const flow = new Flow(out, plainStyle);
    flow.open('memnox doctor');

    flow.list('Found', [
      { tone: TONE.WARN, text: 'a key is readable', detail: ['~/.ssh/id_ed25519'] },
      { tone: TONE.OK, text: 'a rule closes it' },
    ]);

    const text = out.lines.join('\n');
    expect(text).toContain('!  a key is readable');
    expect(text).toContain('+  a rule closes it');
    expect(text).toContain('~/.ssh/id_ed25519');
  });

  it('drops the rail entirely in plain mode rather than drawing it in ASCII', () => {
    /* A gutter character on every line of a log file is noise nobody asked for,
       and the labels carry the structure without it. */
    const text = drawn(plainStyle).out.lines.join('\n');

    expect(text).toContain('Control plane');
    expect(text).toContain('Enrolled');
    for (const mark of ['│', '◇', '┌', '└', '╭', '╰']) {
      expect(text, mark).not.toContain(mark);
    }
  });

  it('says everything in plain mode that it says decorated', () => {
    // The chrome may go; a fact may not.
    const plain = drawn(plainStyle).out.lines.join('\n');
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
