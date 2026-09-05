import { mkdtemp, readFile, stat, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  applyConfigValue,
  configPathFor,
  DEFAULT_CONFIG,
  FIRST_RUN_MODE,
  isConfigKey,
  loadOrCreateConfig,
  parseConfig,
  renderConfig,
  saveConfig,
  validateConfigValue,
} from '../src/config/index';

const home = (): Promise<string> => mkdtemp(join(tmpdir(), 'memnox-config-'));

describe('the config file', () => {
  it('starts in observe, because a runtime that denies on day one gets uninstalled', () => {
    expect(FIRST_RUN_MODE).toBe('observe');
    expect(DEFAULT_CONFIG.mode).toBe('observe');
  });

  it('writes itself on first run and reads back what it wrote', async () => {
    const dir = await home();
    const first = await loadOrCreateConfig(dir);
    expect(first).toEqual(DEFAULT_CONFIG);
    expect(await readFile(configPathFor(dir), 'utf8')).toContain('mode = "observe"');
  });

  it('never overwrites an edit somebody made on purpose', async () => {
    const dir = await home();
    await loadOrCreateConfig(dir);
    await saveConfig(dir, { ...DEFAULT_CONFIG, mode: 'enforce', retentionDays: 7 });

    const second = await loadOrCreateConfig(dir);
    expect(second.mode).toBe('enforce');
    expect(second.retentionDays).toBe(7);
  });

  it('keeps the file owner-only, like everything else under the data directory', async () => {
    const dir = await home();
    await loadOrCreateConfig(dir);
    const mode = (await stat(configPathFor(dir))).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('round-trips through render and parse', () => {
    const config = {
      mode: 'advise' as const,
      retentionDays: 90,
      failOpen: true,
      telemetry: true,
      approvedAgents: ['claude-code', 'cursor'],
    };
    expect(parseConfig(renderConfig(config))).toEqual(config);
  });

  it('ignores comments, blank lines and section headers', () => {
    const parsed = parseConfig('# a note\n\n[section]\nmode = "enforce"\n');
    expect(parsed.mode).toBe('enforce');
  });

  it('falls back to the default rather than accepting a mode that is not one', () => {
    expect(parseConfig('mode = "yolo"').mode).toBe(DEFAULT_CONFIG.mode);
    expect(parseConfig('retentionDays = -4').retentionDays).toBe(
      DEFAULT_CONFIG.retentionDays,
    );
  });

  it('reads a hand-written file that never went through render', async () => {
    const dir = await home();
    await mkdir(join(dir, '.memnox'), { recursive: true });
    await writeFile(configPathFor(dir), "mode='enforce'\nfailOpen = true\n");

    const config = await loadOrCreateConfig(dir);
    expect(config.mode).toBe('enforce');
    expect(config.failOpen).toBe(true);
  });
});

describe('changing one setting', () => {
  it('names the settings that exist', () => {
    expect(isConfigKey('mode')).toBe(true);
    expect(isConfigKey('nonsense')).toBe(false);
  });

  it('refuses a mode that is not one, and says which are', () => {
    const result = validateConfigValue('mode', 'sometimes');
    expect(result.error).toContain('observe');
  });

  it('refuses a retention that would silently mean "keep nothing"', () => {
    expect(validateConfigValue('retentionDays', '0').error).toContain('above zero');
    expect(validateConfigValue('retentionDays', '1.5').error).toBeDefined();
    expect(validateConfigValue('retentionDays', '30').error).toBeUndefined();
  });

  it('refuses a boolean that is not one', () => {
    expect(validateConfigValue('failOpen', 'yes').error).toContain('true or false');
    expect(validateConfigValue('failOpen', 'true').error).toBeUndefined();
  });

  it('applies a change without touching anything else', () => {
    const next = applyConfigValue(DEFAULT_CONFIG, 'mode', 'enforce');
    expect(next.mode).toBe('enforce');
    expect(next.retentionDays).toBe(DEFAULT_CONFIG.retentionDays);
    expect(DEFAULT_CONFIG.mode).toBe('observe');
  });
});
