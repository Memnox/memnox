import { DECISION_EFFECT, ENFORCEMENT_MODE } from '@memnox/core';
import type { RecentDecision, RuntimeStatus } from '../runtime-status';

/**
 * The status page, rendered as one self-contained document. Pure: it takes a
 * status and returns HTML, so the route stays shape-only and a test can assert
 * on markup without binding a port.
 *
 * Tokens are copied from @memnox/ui in the memnox-client repo rather than
 * imported — the runtime ships as a standalone npm package and cannot depend on
 * a sibling workspace. Keep the values in step by hand when the palette moves.
 */

/** Seconds between reloads. Long enough to read a row, short enough to feel live. */
const REFRESH_SECONDS = 5;

const EFFECT_LABEL: Record<string, string> = {
  [DECISION_EFFECT.ALLOW]: 'ALLOW',
  [DECISION_EFFECT.BLOCK]: 'BLOCK',
  [DECISION_EFFECT.REQUIRE_APPROVAL]: 'APPROVAL',
};

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function renderDashboard(status: RuntimeStatus): string {
  const observing = status.enforcement !== ENFORCEMENT_MODE.ENFORCE;
  return `<!doctype html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="${REFRESH_SECONDS}">
<title>Memnox — ${escapeHtml(status.enforcement)}</title>
<style>${STYLES}</style>
</head>
<body>
<main>
  <header>
    <h1>Memnox</h1>
    <span class="mode ${observing ? 'mode-observing' : 'mode-enforcing'}">
      ${observing ? 'observing' : 'enforcing'}
    </span>
  </header>
  ${observing ? OBSERVING_BANNER : ''}

  <section class="tiles">
    ${tile('Policies', String(status.policyCount), `version ${escapeHtml(status.policyVersion)}`)}
    ${tile('Decisions', String(status.recentDecisions), 'recent')}
    ${tile('Approvals', String(status.pendingApprovals), 'waiting', status.pendingApprovals > 0)}
    ${tile('Withheld', String(status.withheld), 'if enforcing', status.withheld > 0)}
  </section>

  <section>
    <h2>Guards</h2>
    <ul class="guards">
      ${status.guards.map((guard) => `<li>${escapeHtml(guard)}</li>`).join('')}
    </ul>
  </section>

  <section>
    <h2>Recent decisions</h2>
    ${status.recent.length === 0 ? EMPTY_DECISIONS : decisionTable(status.recent)}
  </section>

  <footer>Refreshes every ${REFRESH_SECONDS}s · <code>memnox audit</code> for the full trail</footer>
</main>
</body>
</html>`;
}

function tile(label: string, value: string, hint: string, attention = false): string {
  return `<div class="tile${attention ? ' tile-attention' : ''}">
      <div class="tile-value">${escapeHtml(value)}</div>
      <div class="tile-label">${escapeHtml(label)}</div>
      <div class="tile-hint">${escapeHtml(hint)}</div>
    </div>`;
}

function decisionTable(recent: readonly RecentDecision[]): string {
  return `<table>
      <thead><tr><th>Time</th><th>Verdict</th><th>Agent</th><th>Action</th><th>Reason</th></tr></thead>
      <tbody>${recent.map(decisionRow).join('')}</tbody>
    </table>`;
}

function decisionRow(event: RecentDecision): string {
  // The withheld verdict is what policy decided; the effect is what happened.
  const shown = event.withheldEffect ?? event.effect;
  const label = EFFECT_LABEL[shown] ?? shown;
  const target = event.target === undefined ? '' : ` ${escapeHtml(event.target)}`;
  const withheldNote =
    event.withheldEffect === undefined ? '' : `<span class="withheld">withheld</span>`;
  return `<tr>
      <td class="dim">${escapeHtml(event.occurredAt)}</td>
      <td><span class="verdict verdict-${escapeHtml(shown)}">${escapeHtml(label)}</span>${withheldNote}</td>
      <td>${escapeHtml(event.agentName)}</td>
      <td><code>${escapeHtml(event.action)}${target}</code></td>
      <td class="dim">${escapeHtml(event.reason)}</td>
    </tr>`;
}

const OBSERVING_BANNER = `<p class="banner">Nothing is being blocked. Decisions are recorded so you can read them before arming — <code>memnox setup --enforce</code>.</p>`;

const EMPTY_DECISIONS = `<p class="dim">No decisions yet. Restart your editor, then make an edit.</p>`;

const STYLES = `
:root {
  --background: #f1f5f9; --foreground: #0f172a; --card: #ffffff;
  --muted: #f1f5f9; --muted-foreground: #475569; --border: #dfe7f1;
  --primary: #1e86ee; --destructive: #e31957; --ok: #37cd8f; --warn: #dd815d;
  --radius: 0.375rem;
}
:root[data-theme="dark"] {
  --background: #0c0c0c; --foreground: #f5f5f5; --card: #1c1c1c;
  --muted: #1f1f1f; --muted-foreground: #a3a3a3; --border: #2e2e2e;
  --primary: #1e86ee; --destructive: #e31957; --ok: #37cd8f; --warn: #dd815d;
}
* { box-sizing: border-box; }
body {
  margin: 0; background: var(--background); color: var(--foreground);
  font: 14px/1.5 ui-sans-serif, -apple-system, "Segoe UI", sans-serif;
}
main { max-width: 60rem; margin: 0 auto; padding: 2rem 1.25rem 3rem; }
header { display: flex; align-items: center; gap: .75rem; margin-bottom: 1rem; }
h1 { font-size: 1.25rem; margin: 0; letter-spacing: -.01em; }
h2 { font-size: .8rem; text-transform: uppercase; letter-spacing: .08em;
     color: var(--muted-foreground); margin: 2rem 0 .75rem; font-weight: 600; }
.mode { font-size: .75rem; padding: .15rem .5rem; border-radius: 999px;
        border: 1px solid var(--border); }
.mode-observing { color: var(--warn); }
.mode-enforcing { color: var(--ok); }
.banner { background: var(--card); border: 1px solid var(--border);
          border-left: 3px solid var(--warn); border-radius: var(--radius);
          padding: .75rem 1rem; margin: 0; color: var(--muted-foreground); }
.tiles { display: grid; gap: .75rem; grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr));
         margin-top: 1.25rem; }
.tile { background: var(--card); border: 1px solid var(--border);
        border-radius: var(--radius); padding: 1rem; }
.tile-attention { border-color: var(--warn); }
.tile-value { font-size: 1.75rem; font-weight: 600; line-height: 1.1; }
.tile-label { font-size: .8rem; margin-top: .25rem; }
.tile-hint { font-size: .75rem; color: var(--muted-foreground); }
.guards { list-style: none; display: flex; flex-wrap: wrap; gap: .4rem; padding: 0; margin: 0; }
.guards li { font-size: .75rem; padding: .2rem .55rem; border-radius: 999px;
             background: var(--muted); border: 1px solid var(--border); }
table { width: 100%; border-collapse: collapse; font-size: .8rem;
        background: var(--card); border: 1px solid var(--border);
        border-radius: var(--radius); overflow: hidden; }
th { text-align: left; font-weight: 600; color: var(--muted-foreground);
     font-size: .7rem; text-transform: uppercase; letter-spacing: .06em; }
th, td { padding: .5rem .75rem; border-bottom: 1px solid var(--border);
         vertical-align: top; }
tr:last-child td { border-bottom: 0; }
.dim { color: var(--muted-foreground); }
code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .95em; }
.verdict { font-weight: 600; font-size: .7rem; }
.verdict-allow { color: var(--ok); }
.verdict-block { color: var(--destructive); }
.verdict-require_approval { color: var(--warn); }
.withheld { font-size: .65rem; color: var(--muted-foreground); margin-left: .35rem; }
footer { margin-top: 2.5rem; font-size: .75rem; color: var(--muted-foreground); }
/* The page ships one look; honour a light system preference rather than forcing dark. */
@media (prefers-color-scheme: light) {
  :root[data-theme="dark"] {
    --background: #f1f5f9; --foreground: #0f172a; --card: #ffffff;
    --muted: #f1f5f9; --muted-foreground: #475569; --border: #dfe7f1;
  }
}
`;
