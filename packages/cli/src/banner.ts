import type { Style } from './style';

/**
 * The wordmark, as blocks.
 *
 * Six letters on a five-row grid, each drawn twice: once as the face and once
 * offset a cell down and right as its shadow. Composited from one grid rather
 * than written as two strings, so the layers cannot drift — a shadow kept in
 * step by hand is one that slips a column the first time a letter is touched.
 *
 * Decoration, so it is printed as commentary and never as output, and a style
 * that draws nothing gets the plain word instead. A wall of block characters in
 * a log file is worse than no wordmark at all.
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
        (grid[row] as boolean[]).push(art[column] === DRAWN);
      }
    }
  }
  return grid;
}

const at = (grid: readonly boolean[][], row: number, column: number): boolean =>
  row >= 0 && column >= 0 && (grid[row]?.[column] ?? false);

/**
 * The wordmark, one string per line.
 *
 * A row taller than the face, because the last row's shadow falls below it and
 * a banner clipped at the bottom reads as a rendering fault.
 */
export function wordmark(style: Style, plain: string): string[] {
  if (!style.decorated) return [plain];

  const grid = faceGrid();
  const width = grid[0]?.length ?? 0;
  const lines: string[] = [];

  for (let row = 0; row <= ROWS; row += 1) {
    let line = '';
    for (let column = 0; column < width; column += 1) {
      if (at(grid, row, column)) line += style.bold(FACE);
      // The cell up and to the left is what casts into this one.
      else if (at(grid, row - 1, column - 1)) line += style.dim(SHADOW);
      else line += ' ';
    }
    lines.push(line);
  }
  return lines;
}
