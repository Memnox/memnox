#!/usr/bin/env bash
# Publishes every package from this machine, in dependency order, answering the
# OTP interactively. The release workflow is the normal path; this exists because
# an account with 2FA on writes rejects any CI token as EOTP, and until trusted
# publishing is configured a person at a keyboard is the only thing npm accepts.
#
# What it costs: npm cannot attest a local build, so these publish WITHOUT
# provenance. Every release before this carried one. Use the workflow when it works.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    *) printf 'usage: %s [--dry-run]\n' "$0" >&2; exit 2 ;;
  esac
done

# One version across every package, exactly as the workflow requires: a package
# left behind publishes a duplicate of something already out, or nothing at all.
version_of() { node -p "require('./packages/$1/package.json').version"; }

VERSION=""
mismatched=""
for dir in packages/*/; do
  name="$(basename "$dir")"
  [[ -f "$dir/package.json" ]] || continue
  node -e "process.exit(require('./$dir/package.json').private ? 1 : 0)" || continue
  v="$(version_of "$name")"
  if [[ -z "$VERSION" ]]; then VERSION="$v"; fi
  [[ "$v" == "$VERSION" ]] || mismatched="$mismatched $name@$v"
done

if [[ -n "$mismatched" ]]; then
  printf 'versions disagree, expected %s:%s\n' "$VERSION" "$mismatched" >&2
  exit 1
fi

# Derived from the manifests, never a hardcoded list: a package added later would
# be silently skipped, and a release missing a package is not something a build fails on.
ORDER="$(node -e "
  const fs = require('fs');
  const pkgs = {};
  for (const dir of fs.readdirSync('packages')) {
    const file = 'packages/' + dir + '/package.json';
    if (!fs.existsSync(file)) continue;
    const p = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (p.private) continue;
    pkgs[p.name] = Object.keys({ ...p.dependencies, ...p.peerDependencies })
      .filter((d) => d === 'memnox' || d.startsWith('@memnox/'));
  }
  const done = new Set(), order = [];
  while (order.length < Object.keys(pkgs).length) {
    const ready = Object.entries(pkgs)
      .filter(([n, deps]) => !done.has(n) && deps.every((d) => done.has(d)))
      .map(([n]) => n).sort();
    if (!ready.length) { console.error('dependency cycle'); process.exit(1); }
    for (const n of ready) { done.add(n); order.push(n); }
  }
  console.log(order.join('\n'));
")"

# Asked all at once: one at a time is a nineteen-round trip stare before the first
# question, and a person who waited that long reads the prompt as output, not a prompt.
printf '\nChecking the registry'
for pkg in $ORDER; do
  ( npm view "$pkg@$VERSION" version >/dev/null 2>&1 && echo "$pkg" > "$WORK/$(echo "$pkg" | tr / _).out" ) &
done
wait
printf ' done.\n'

printf '\nRelease %s from this machine, without provenance.\n\n' "$VERSION"
todo=0
for pkg in $ORDER; do
  if [[ -f "$WORK/$(echo "$pkg" | tr / _).out" ]]; then
    printf '  skip     %s@%s is already published\n' "$pkg" "$VERSION"
  else
    printf '  publish  %s@%s\n' "$pkg" "$VERSION"
    todo=$((todo + 1))
  fi
done

if [[ "$todo" -eq 0 ]]; then
  printf '\nEverything at %s is already on the registry.\n' "$VERSION"
  exit 0
fi

printf '\n%d package(s) to publish. npm versions are immutable.\n' "$todo"
if [[ "$DRY_RUN" -eq 1 ]]; then
  printf 'Dry run, nothing published.\n'
  exit 0
fi

# The answer is an argument when one is given, so this is drivable by a test. It
# buys nothing else: npm still asks for the OTP on a terminal, so a run without one
# gets past this line and no further.
confirmed="${MEMNOX_PUBLISH_CONFIRM:-}"

if [[ -z "$confirmed" ]]; then
  # No terminal means npm cannot ask for the OTP. Saying so here beats discovering
  # it at the first package, after a confirmation the reader has already given.
  if [[ ! -t 0 ]]; then
    printf '\nNo terminal on stdin, so npm could not ask for your OTP.\n' >&2
    printf 'Run this directly rather than through a pipe or a wrapper.\n' >&2
    exit 1
  fi

  # An empty line is a stray return, not an answer, so it is asked again rather than
  # treated as a refusal after the reader has waited through the whole plan.
  for _ in 1 2; do
    printf 'Type %s to publish, or anything else to stop: ' "$VERSION"
    read -r confirmed
    [[ -n "$confirmed" ]] && break
  done
fi

if [[ "$confirmed" != "$VERSION" ]]; then
  printf 'Not confirmed, nothing published.\n' >&2
  exit 1
fi

npm ci
npm run build

# Published one at a time with stdin left on the terminal: reading the list from a
# pipe takes stdin away, and npm then has nowhere to prompt for the OTP. That is a
# real failure this script exists to stop repeating.
published=0
for pkg in $ORDER; do
  if npm view "$pkg@$VERSION" version >/dev/null 2>&1; then
    printf '\nskip     %s@%s\n' "$pkg" "$VERSION"
    continue
  fi
  printf '\npublish  %s@%s\n' "$pkg" "$VERSION"
  # Codes expire in about thirty seconds, so npm re-prompts as it works down the list.
  if ! npm publish -w "$pkg" --access public --no-provenance; then
    printf '\nStopped at %s. Re-run this script: what already landed is skipped.\n' "$pkg" >&2
    exit 1
  fi
  published=$((published + 1))
done

printf '\nPublished %d package(s) at %s.\n' "$published" "$VERSION"
printf 'These carry no provenance. Configure trusted publishing so the next one does.\n'
