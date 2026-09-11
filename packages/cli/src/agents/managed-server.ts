import {
  CONFIG_FORMAT,
  formatOf,
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
 * The Memnox server entry an onboarded agent gets, and taking it back out.
 *
 * Three formats, because three of the agents on an ordinary laptop are not
 * JSON: Codex keeps TOML and Hermes keeps YAML, and declining those meant half
 * the agents Memnox could *find* were agents it could not *govern*.
 *
 * Every one of them is edited in place rather than re-serialized, and none of
 * them reformats a line it did not change. TOML gets a table appended as text,
 * YAML goes through a document that keeps its comments, and JSON is edited by
 * span through `jsonc-parser`. The last of those was the worst offender before
 * it was: re-serializing rewrote every line of the file, so adding four lines
 * produced a diff touching a hundred.
 *
 * **Every rewrite is checked before it is returned.** The result is parsed back
 * with the same parser the detectors use, and it has to still hold every server
 * it held before plus the managed one. A rewrite that loses somebody's servers,
 * or produces a file that no longer parses, is refused and the original is left
 * alone. That is what makes adding a format safe rather than a hope: being
 * wrong about a spelling costs a connection that does not authenticate, never
 * a config that will not load.
 */

export { MANAGED_SERVER, managedServerFor };

/** Whether this file is one of the three shapes onboarding can edit at all. */
export function canRewrite(path: string): boolean {
  return formatOf(path) !== null;
}

/**
 * Adds the managed server, keeping everything else exactly as it was.
 *
 * `serversKey` applies to JSON only, where two spellings are in the wild and the
 * caller has already read which one this file uses. TOML and YAML each have one
 * spelling their own tooling goes by, so each format module decides its own.
 */
export function withManagedServer(
  raw: string,
  serversKey: string,
  server: ManagedServer,
  path = '.json',
): RewriteResult {
  const format = formatOf(path);
  if (format === null) {
    return { next: null, because: 'its config is in a format this cannot rewrite' };
  }
  const before = serverNames(raw, format);
  if (before === null) {
    return { next: null, because: notReadable(format) };
  }

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

/**
 * Takes the managed server back out.
 *
 * Used only where the backup cannot be restored. Restoring is the honest undo
 * because it puts back exactly what was there, including anything a person
 * changed by hand afterwards being *lost* rather than merged, which is what an
 * undo means. This is the fallback for a backup that has gone missing.
 */
export function withoutManagedServer(
  raw: string,
  serversKey: string,
  path = '.json',
): RewriteResult {
  const format = formatOf(path);
  if (format === null) {
    return { next: null, because: 'its config is in a format this cannot rewrite' };
  }
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
 * The rewrite, read back.
 *
 * A file that no longer parses, or that has lost a server it held, is refused
 * and the caller writes nothing. This is the whole safety story for a format
 * whose exact spelling for an HTTP entry we are taking on trust: the worst a
 * wrong guess can do is leave an entry the agent cannot connect through, which
 * `offboard` reverses, rather than a config the agent cannot load.
 */
function checked(
  written: RewriteResult,
  raw: string,
  format: ConfigFormat,
  expected: readonly string[],
): RewriteResult {
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
