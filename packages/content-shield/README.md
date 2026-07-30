# @memnox/content-shield

Catches secrets and PII in content an agent is about to write — before the write
lands, not after the commit.

Deterministic, offline, no network. Same content in, same findings out.

## Scanning

```ts
import { scanContent, scanDiff } from '@memnox/content-shield';

scanContent('src/config.ts', fileContents);
// [{ rule: 'aws-access-key', line: 12, severity: 'critical', excerpt: '…', fix: '…' }]

scanDiff(gitDiff);
// { findings: [...], blocked: true, scannedFiles: 4, rulesetVersion: 3 }
```

On the decision path, `ContentShieldAdvisor` scans `code.write` and `code.modify`
requests that carry their content, and escalates when a finding is blocking.

In CI: `memnox ci --staged`.

## Findings are redacted

A finding reports enough to locate the problem and nothing more — the matched
secret is never echoed in full into a log, a Slack message, or an API response.
A scanner that prints the credential it found has just leaked it somewhere new.

## Path routing

`path-routing.ts` classifies a path before scanning it. Test fixtures, lockfiles,
and vendored directories hold credential-shaped strings that are not credentials;
scanning them produces noise, and noise gets the whole tool switched off. Some
path kinds are skipped, others are scanned with a narrower rule set.

## Severity and blocking

Not every finding blocks. A hardcoded AWS key is `critical` and blocks; an email
address in a log line is a warning that is reported but allowed through. The
split lives in `shield-rules.ts` — `isBlocking` is the single place that decides.

## Introduced, not present

The editor hook compares the proposed content against what is on disk and only
blocks findings the edit **introduces**. Otherwise every subsequent edit to a
file that already contains a finding would be blocked, and the developer would
uninstall the hook. See `shieldDenialMessage` in the `memnox` CLI package.

## The security baseline

Scanning answers *"is there a secret in this content?"*. The baseline answers the
question that comes earlier — *"what must a change of this kind satisfy?"* — so an
agent can carry the requirements into its work instead of tripping over them.

```ts
import { securityRequirementsFor, SECURITY_BASELINE_VERSION } from '@memnox/content-shield';

securityRequirementsFor('file.write', 'src/api/upload.ts');
// [{ id: 'upload-validate-type', requirement: '…', why: '…' }, …]
```

A lookup table, not a model: the same action and target always produce the same
requirements in the same order, so a briefing is cacheable, diffable, and reproducible
against `SECURITY_BASELINE_VERSION`. Covered classes: auth/authz/session/credentials,
upload handling, endpoints, SQL, XSS, deserialization, crypto, shell injection, supply
chain, data export, migrations, and deploy secrets — plus two universal rules that
always apply. An action with no side effect (`file.read`) returns nothing.

The runtime surfaces these through `POST /v1/context`; see the root README.

**These are requirements for a class of work, never findings about code someone
wrote.** Memnox states what a change must satisfy; it does not review the change.

## Layout

| File | Responsibility |
|---|---|
| `shield-rules.ts` | the rule set: patterns, severity, fix advice |
| `security-requirements.ts` | the shipped security baseline, keyed by action and target |
| `path-routing.ts` | path → kind, and which kinds are skipped |
| `finding.ts` | the finding shape and redaction |
| `scanner.ts` | `scanContent` and `scanDiff` |
| `package-advisories.ts` | curated vulnerable-package table |
| `content-shield-advisor.ts` | the escalation hook |

## Adding a security requirement

Add it to the matching `RequirementRule` in `security-requirements.ts` with a stable
`id`, what the change must do, and one line on what goes wrong when it does not. Bump
`SECURITY_BASELINE_VERSION`, and add a case asserting the id appears for a
representative target. Requirements are deduplicated by id when several rules match.

## Adding a rule

Add it to `shield-rules.ts` with a pattern, a severity, and one line of fix
advice, then add both a positive and a negative case to the scanner tests.
Assemble credential-shaped strings at runtime in tests (`['AKIA','...'].join('')`) —
the repo's own Security Shield blocks writing a literal one.
