import type { CliOutput } from './cli-output';
import type { Style } from './style';

/**
 * The wordmark, as blocks: six letters on a five row grid with a ledge under them, drawn
 * from one grid so the layers cannot drift. A plain style gets the word instead.
 */

/** One string per row, `#` where a block is drawn. Widths need not match. */
const LETTERS: readonly (readonly string[])[] = [
  ['##   ##', '### ###', '## # ##', '##   ##', '##   ##'],
  ['######', '##', '#####', '##', '######'],
  ['##   ##', '### ###', '## # ##', '##   ##', '##   ##'],
  ['##   ##', '###  ##', '## # ##', '##  ###', '##   ##'],
  [' #####', '##   ##', '##   ##', '##   ##', ' #####'],
  ['##   ##', ' ## ##', '  ###', ' ## ##', '##   ##'],
];

const ROWS = 5;
/** Blank columns between one letter and the next. */
const TRACKING = 1;
const FACE = '█';
/** Half height, so the shadow reads as behind the face rather than beside it. */
const SHADOW = '▄';
const DRAWN = '#';

/** The letters laid out side by side, as a grid of "is a block drawn here". */
function faceGrid(): boolean[][] {
  const grid: boolean[][] = Array.from({ length: ROWS }, () => []);
  for (const letter of LETTERS) {
    const width = Math.max(...letter.map((row) => row.length));
    for (let row = 0; row < ROWS; row += 1) {
      const art = letter[row] ?? '';
      for (let column = 0; column < width + TRACKING; column += 1) {
        // Every row index below ROWS was created above.
        (grid[row] as boolean[]).push(art[column] === DRAWN);
      }
    }
  }
  return grid;
}

function isDrawn(grid: readonly boolean[][], row: number, column: number): boolean {
  return row >= 0 && column >= 0 && (grid[row]?.[column] ?? false);
}

/**
 * Whether the shadow shows at this cell: the row under the word only, offset one column
 * right, because a true drop shadow lands inside counters one or two cells wide.
 */
function isShadowed(grid: readonly boolean[][], row: number, column: number): boolean {
  return row === ROWS && isDrawn(grid, ROWS - 1, column - 1);
}

/** The wordmark, one string per line, a row taller than the face so the shadow is not clipped. */
export function wordmark(style: Style, plain: string): string[] {
  if (!style.decorated) return [plain];

  const grid = faceGrid();
  const width = grid[0]?.length ?? 0;
  const lines: string[] = [];

  for (let row = 0; row <= ROWS; row += 1) {
    let line = '';
    for (let column = 0; column < width; column += 1) {
      if (isDrawn(grid, row, column)) line += style.bold(FACE);
      else if (isShadowed(grid, row, column)) line += style.dim(SHADOW);
      else line += ' ';
    }
    lines.push(line);
  }
  return lines;
}

/** The wordmark above a run, on stderr so a piped payload arrives alone. */
export function renderMasthead(out: CliOutput, style: Style): void {
  if (!style.decorated) return;
  out.note('');
  for (const line of wordmark(style, 'memnox')) out.note(line);
  out.note('');
}
