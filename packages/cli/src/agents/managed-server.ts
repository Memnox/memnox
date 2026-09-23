import {
  CONFIG_FORMAT,
  configFormatOf,
  MANAGED_SERVER,
  managedServerFor,
  type ConfigFormat,
  type ManagedServer,
  type RewriteResult,
} from './managed-shape';
import {
  tomlServerNames,
  withManagedTomlServer,
  withoutManagedTomlServer,
} from './managed-toml';
import {
  withManagedYamlServer,
  withoutManagedYamlServer,
  yamlServerNames,
} from './managed-yaml';
import {
  jsonServerNames,
  withManagedJsonServer,
  withoutManagedJsonServer,
} from './managed-json';

/**
 * The Memnox server entry an onboarded agent gets in JSON, TOML or YAML, and taking it
 * back out. Every rewrite is parsed back and refused unless it still holds every server.
 */

export { MANAGED_SERVER, managedServerFor };

const UNKNOWN_FORMAT: RewriteResult = {
  next: null,
  because: 'its config is in a format this cannot rewrite',
};

/** Whether this file is one of the three shapes onboarding can edit at all. */
export function canRewrite(path: string): boolean {
  return configFormatOf(path) !== null;
}

/**
 * Adds the managed server, keeping everything else exactly as it was. `serversKey` is
 * JSON only, where two spellings are in the wild; TOML and YAML each decide their own.
 */
export function withManagedServer(
  raw: string,
  serversKey: string,
  server: ManagedServer,
  path = '.json',
): RewriteResult {
  const format = configFormatOf(path);
  if (format === null) return UNKNOWN_FORMAT;
  const before = serverNames(raw, format);
  if (before === null) return { next: null, because: notReadable(format) };

  const written = write(raw, serversKey, server, format);
  if (written.next === null) return written;
  return checked(written, raw, format, [...before, MANAGED_SERVER]);
}

function write(
  raw: string,
  serversKey: string,
  server: ManagedServer,
  format: ConfigFormat,
): RewriteResult {
  if (format === CONFIG_FORMAT.TOML) return withManagedTomlServer(raw, server);
  if (format === CONFIG_FORMAT.YAML) return withManagedYamlServer(raw, server);

  return withManagedJsonServer(raw, serversKey, server);
}

/** Takes the managed server back out, as the fallback for a missing backup, which is the honest undo. */
export function withoutManagedServer(
  raw: string,
  serversKey: string,
  path = '.json',
): RewriteResult {
  const format = configFormatOf(path);
  if (format === null) return UNKNOWN_FORMAT;
  const before = serverNames(raw, format);
  if (before === null) return { next: null, because: notReadable(format) };

  const removed = erase(raw, serversKey, format);
  if (removed.next === null || removed.next === raw) return removed;
  return checked(
    removed,
    raw,
    format,
    before.filter((name) => name !== MANAGED_SERVER),
  );
}

function erase(raw: string, serversKey: string, format: ConfigFormat): RewriteResult {
  if (format === CONFIG_FORMAT.TOML) return withoutManagedTomlServer(raw);
  if (format === CONFIG_FORMAT.YAML) return withoutManagedYamlServer(raw);

  return withoutManagedJsonServer(raw, serversKey);
}

/**
 * The rewrite, read back: a file that no longer parses or has lost a server is refused,
 * so the worst a wrong guess can do is leave an entry that does not connect.
 */
function checked(
  written: RewriteResult,
  raw: string,
  format: ConfigFormat,
  expected: readonly string[],
): RewriteResult {
  // Callers pass only a rewrite that produced text.
  const after = serverNames(written.next as string, format);
  if (after === null) {
    return {
      next: null,
      because: 'the rewritten config would not parse, so it was not written',
    };
  }
  const lost = expected.filter((name) => !after.includes(name));
  if (lost.length > 0) {
    return {
      next: null,
      because: `the rewrite would have dropped ${lost.join(', ')}, so it was not written`,
    };
  }
  // Unchanged is a valid outcome: there was nothing of ours to remove.
  return written.next === raw ? { next: raw } : written;
}

/** Every server a config declares, by whichever parser owns that format. */
function serverNames(raw: string, format: ConfigFormat): string[] | null {
  if (format === CONFIG_FORMAT.TOML) return tomlServerNames(raw);
  if (format === CONFIG_FORMAT.YAML) return yamlServerNames(raw);
  return jsonServerNames(raw);
}

function notReadable(format: ConfigFormat): string {
  return `its config is not ${format.toUpperCase()} this can rewrite`;
}
