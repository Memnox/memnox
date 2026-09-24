/** Points every test at a throwaway home, so a seam a test forgot to inject never reaches the real one. */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'memnox-test-home-'));
process.env['HOME'] = home;
process.env['USERPROFILE'] = home;
