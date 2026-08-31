import { DECISION_EFFECT, ENFORCEMENT_MODE } from '@memnox/core';
import type { RecentDecision, RuntimeStatus } from '../runtime-status';
import { MEMNOX_MARK_DATA_URI } from './dashboard-mark';
import { DASHBOARD_SCRIPT } from './dashboard-script';
import { DASHBOARD_CSS } from './dashboard-styles';

/** Pure: status in, HTML out, so the route stays a route. */

/** Seconds between polls. Long enough to read a row, short enough to feel live. */
const REFRESH_SECONDS = 5;

const EFFECT_LABEL: Record<string, string> = {
  [DECISION_EFFECT.ALLOW]: 'ALLOW',
  [DECISION_EFFECT.WITHHOLD]: 'WITHHOLD',
  [DECISION_EFFECT.ESCALATE]: 'ESCALATE',
};

const AGENT_KINDS = ['claude-code', 'cursor', 'openai-agent', 'mcp', 'custom'];

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** A browser cannot send a bearer header on a plain navigation. */
export function renderDashboardGate(nonce: string): string {
  return page(
    'Memnox — sign in',
    `<div class="gate">
  ${lockup('runtime')}
  <div>
    <div class="eyebrow">Sign in</div>
    <h1>This runtime is locked</h1>
  </div>
  <p>Paste a management token to read its decisions. It is kept for this browser
  tab and never written to disk.</p>
  <form id="gate-form" class="stack">
    <label>
      <span>Management token</span>
      <input id="gate-token" class="mono" type="password" autocomplete="off" spellcheck="false" placeholder="the value passed to --admin-token">
    </label>
    <div class="actions"><button class="primary" type="submit">Open</button></div>
  </form>
</div>`,
    nonce,
  );
}

export function renderDashboard(status: RuntimeStatus, nonce: string): string {
  const observing = status.enforcement !== ENFORCEMENT_MODE.ENFORCE;
  return page(
    `Memnox — ${escapeHtml(status.enforcement)}`,
    `<main id="app">
  <header class="topbar">
    ${lockup('runtime')}
    <span id="mode" class="mode ${observing ? 'mode-observing' : 'mode-enforcing'}">${observing ? 'observing' : 'enforcing'}</span>
    <span class="spacer"></span>
    <select id="enforcement" class="auto-width" aria-label="Enforcement mode">
      ${enforcementOptions(status.enforcement)}
    </select>
    <button id="live" class="live" type="button" data-paused="false" title="Pause or resume polling"><span>live</span></button>
  </header>

  <p id="banner" class="banner${observing ? '' : ' hidden'}">Nothing is being withheld. Decisions are recorded so you can read them before arming — switch the mode above, or run <code>memnox setup --enforce</code>.</p>

  <section class="tiles">
    ${tile('policies', 'Policies', String(status.policyCount), `version ${escapeHtml(status.policyVersion)}`)}
    ${tile('decisions', 'Decisions', String(status.recentDecisions), 'recent')}
    ${tile('approvals', 'Approvals', String(status.pendingApprovals), 'waiting', status.pendingApprovals > 0)}
    ${tile('withheld', 'Withheld', String(status.withheld), 'if enforcing', status.withheld > 0)}
  </section>

  <nav class="tabs" role="tablist">
    <button class="tab" role="tab" data-tab="activity" aria-selected="true">Activity</button>
    <button class="tab" role="tab" data-tab="approvals" aria-selected="false">Approvals<span class="count${status.pendingApprovals > 0 ? ' attention' : ''}" id="approvals-count">${status.pendingApprovals}</span></button>
    <button class="tab" role="tab" data-tab="policies" aria-selected="false">Policies</button>
    <button class="tab" role="tab" data-tab="decisions" aria-selected="false">Decisions</button>
    <button class="tab" role="tab" data-tab="agents" aria-selected="false">Agents</button>
    <button class="tab" role="tab" data-tab="console" aria-selected="false">Console</button>
  </nav>

  ${activityPanel(status)}
  ${approvalsPanel()}
  ${policiesPanel()}
  ${decisionsPanel()}
  ${agentsPanel()}
  ${consolePanel()}

  <footer>Polls every ${REFRESH_SECONDS}s · every action here is the same call <code>memnox</code> makes</footer>
</main>

<div id="gate" class="gate hidden">
  ${lockup('runtime')}
  <div>
    <div class="eyebrow">Sign in</div>
    <h1>This runtime is locked</h1>
  </div>
  <p>Paste a management token to carry on.</p>
  <form id="gate-form" class="stack">
    <label>
      <span>Management token</span>
      <input id="gate-token" class="mono" type="password" autocomplete="off" spellcheck="false">
    </label>
    <div class="actions"><button class="primary" type="submit">Open</button></div>
  </form>
</div>`,
    nonce,
  );
}

function page(title: string, body: string, nonce: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${title}</title>
<style nonce="${escapeHtml(nonce)}">${DASHBOARD_CSS}</style>
</head>
<body>
${body}
<div class="toast" id="toast" role="status" aria-live="polite"></div>
<script nonce="${escapeHtml(nonce)}">${DASHBOARD_SCRIPT}</script>
</body>
</html>`;
}

/** The @memnox/ui lockup, so this page is recognisably the same product. */
function lockup(suffix: string): string {
  return `<span class="lockup">
      <img src="${MEMNOX_MARK_DATA_URI}" alt="" aria-hidden="true">
      <span class="word">Memnox</span>
      <span class="suffix">${escapeHtml(suffix)}</span>
    </span>`;
}

function enforcementOptions(current: string): string {
  return Object.values(ENFORCEMENT_MODE)
    .map(
      (mode) =>
        `<option value="${escapeHtml(mode)}"${mode === current ? ' selected' : ''}>${escapeHtml(mode)}</option>`,
    )
    .join('');
}

function tile(
  id: string,
  label: string,
  value: string,
  hint: string,
  attention = false,
): string {
  return `<div class="tile${attention ? ' tile-attention' : ''}" id="tile-${id}-card">
      <div class="tile-value" id="tile-${id}">${escapeHtml(value)}</div>
      <div class="tile-label">${escapeHtml(label)}</div>
      <div class="tile-hint" id="tile-${id}-hint">${escapeHtml(hint)}</div>
    </div>`;
}

function activityPanel(status: RuntimeStatus): string {
  return `<section class="pane stack" data-panel="activity">
    <h2>Guards in force</h2>
    <ul class="chips" id="guards">${status.guards.map((guard) => `<li>${escapeHtml(guard)}</li>`).join('')}</ul>
    <h2>Recent decisions</h2>
    <div class="card"><div class="scroller"><table>
      <thead><tr><th>Time</th><th>Verdict</th><th>Agent</th><th>Action</th><th>Reason</th></tr></thead>
      <tbody id="activity-rows">${
        status.recent.length === 0
          ? EMPTY_ACTIVITY
          : status.recent.map(decisionRow).join('')
      }</tbody>
    </table></div></div>
  </section>`;
}

function approvalsPanel(): string {
  return `<section class="pane stack" data-panel="approvals" hidden>
    <h2>Waiting on a human</h2>
    <label class="narrow">
      <span>Deciding as</span>
      <input id="resolver" placeholder="your name" autocomplete="off">
      <span class="hint">Recorded as the grantor. Not verified against the approver list.</span>
    </label>
    <div id="approvals-list" class="stack"></div>
  </section>`;
}

function policiesPanel(): string {
  return `<section class="pane stack" data-panel="policies" hidden>
    <h2>Rules in force</h2>
    <div class="card"><div class="scroller"><table>
      <thead><tr><th>Name</th><th>Effect</th><th>Matches</th><th></th></tr></thead>
      <tbody id="policy-rows"></tbody>
    </table></div></div>

    <h2>Add a rule</h2>
    <form class="card" id="policy-form">
      <div class="card-body">
        <div class="grid">
          <label><span>Name</span><input id="rule-name" class="mono" placeholder="payment-code-approval" autocomplete="off"></label>
          <label><span>Effect</span><select id="rule-effect">
            <option value="escalate">require approval</option>
            <option value="withhold">block</option>
            <option value="allow">allow</option>
            <option value="redact">redact</option>
          </select></label>
        </div>
        <div class="grid">
          <label><span>Actions</span><input id="rule-actions" class="mono" placeholder="file.write, code.modify" autocomplete="off"><span class="hint">Comma separated. Wildcards allowed.</span></label>
          <label><span>Targets</span><input id="rule-targets" class="mono" placeholder="*payment*" autocomplete="off"><span class="hint">Leave empty to match every target.</span></label>
          <label><span>Environments</span><input id="rule-environments" class="mono" placeholder="production" autocomplete="off"><span class="hint">Leave empty to match every environment.</span></label>
        </div>
        <div class="grid">
          <label><span>Reason</span><input id="rule-reason" placeholder="Payment logic changes need security review." autocomplete="off"><span class="hint">Quoted verbatim to the agent that is refused.</span></label>
          <label><span>Approvers</span><input id="rule-approvers" placeholder="security-team" autocomplete="off"><span class="hint">Only used when the effect is require approval.</span></label>
        </div>
        <div class="actions">
          <button class="primary" type="submit">Add rule</button>
          <span class="hint dim">Writes the whole set to your policy file, then reloads the engine.</span>
        </div>
      </div>
    </form>
  </section>`;
}

function decisionsPanel(): string {
  return `<section class="pane stack" data-panel="decisions" hidden>
    <h2>What the team has decided</h2>
    <div class="card"><div class="scroller"><table>
      <thead><tr><th>Title</th><th>Owner</th><th>Actions</th><th>Status</th><th></th></tr></thead>
      <tbody id="decision-rows"></tbody>
    </table></div></div>

    <h2>Record a decision</h2>
    <form class="card" id="decision-form">
      <div class="card-body">
        <div class="grid">
          <label><span>Title</span><input id="decision-title" placeholder="No direct prod DB writes" autocomplete="off"></label>
          <label><span>Owner</span><input id="decision-owner" placeholder="platform-team" autocomplete="off"></label>
        </div>
        <label><span>Statement</span><textarea id="decision-statement" placeholder="All production schema changes go through a reviewed migration."></textarea><span class="hint">In the team's own words. Quoted back when an action contradicts it.</span></label>
        <div class="grid">
          <label><span>Actions</span><input id="decision-actions" class="mono" placeholder="database.write, database.migrate" autocomplete="off"></label>
          <label><span>Environments</span><input id="decision-environments" class="mono" placeholder="production" autocomplete="off"></label>
          <label><span>Enforcement</span><select id="decision-enforcement">
            <option value="escalate">require approval</option>
            <option value="withhold">block</option>
            <option value="advisory">advisory</option>
          </select></label>
        </div>
        <div class="actions">
          <button class="primary" type="submit">Record</button>
          <span class="hint dim">A decision may tighten a verdict. It never loosens one.</span>
        </div>
      </div>
    </form>
  </section>`;
}

function agentsPanel(): string {
  return `<section class="pane stack" data-panel="agents" hidden>
    <h2>Who is governed</h2>
    <div class="card"><div class="scroller"><table>
      <thead><tr><th>Name</th><th>Kind</th><th>Status</th><th>Trust</th><th></th></tr></thead>
      <tbody id="agent-rows"></tbody>
    </table></div></div>

    <h2>Register an agent</h2>
    <form class="card" id="agent-form">
      <div class="card-body">
        <div class="grid">
          <label><span>Name</span><input id="agent-name" placeholder="ci-deployer" autocomplete="off"></label>
          <label><span>Kind</span><select id="agent-kind">${AGENT_KINDS.map(
            (kind) => `<option value="${escapeHtml(kind)}">${escapeHtml(kind)}</option>`,
          ).join('')}</select></label>
        </div>
        <div class="actions"><button class="primary" type="submit">Register</button></div>
        <pre class="readout hidden" id="agent-token"></pre>
      </div>
    </form>
  </section>`;
}

function consolePanel(): string {
  return `<section class="pane stack" data-panel="console" hidden>
    <h2>Ask the runtime</h2>
    <form class="card" id="console-form">
      <div class="card-body">
        <label><span>Agent token</span>
          <span class="row">
            <input id="console-token" class="mono" type="password" placeholder="mnx_…" autocomplete="off">
            <button id="console-token-new" class="ghost" type="button">Get a token</button>
          </span>
          <span class="hint">A check is asked as an agent, not as an operator. "Get a token" registers an agent for this console — the one <code>memnox setup</code> made is not readable, because a token is only ever shown once.</span>
        </label>
        <div class="grid">
          <label><span>Action</span><input id="console-action" class="mono" placeholder="database.drop" autocomplete="off"></label>
          <label><span>Target</span><input id="console-target" class="mono" placeholder="users" autocomplete="off"></label>
          <label><span>Environment</span><input id="console-environment" class="mono" placeholder="production" autocomplete="off"></label>
          <label><span>Amount</span><input id="console-amount" class="mono" type="number" placeholder="4500" autocomplete="off"><span class="hint">Only for actions that move money.</span></label>
        </div>
        <div class="actions">
          <button class="primary" type="submit">Ask</button>
          <span class="hint dim">This records a real decision in the audit trail.</span>
        </div>
        <pre class="readout hidden" id="console-result"></pre>
      </div>
    </form>
  </section>`;
}

function decisionRow(event: RecentDecision): string {
  // The withheld verdict is what policy decided; the effect is what happened.
  const shown = event.shadowEffect ?? event.effect;
  const label = EFFECT_LABEL[shown] ?? shown;
  const target = event.target === undefined ? '' : ` ${escapeHtml(event.target)}`;
  const withheldNote =
    event.shadowEffect === undefined ? '' : `<span class="tag">withheld</span>`;
  return `<tr>
      <td class="n dim">${escapeHtml(event.occurredAt)}</td>
      <td><span class="verdict verdict-${escapeHtml(shown)}">${escapeHtml(label)}</span>${withheldNote}</td>
      <td>${escapeHtml(event.agentName)}</td>
      <td><code>${escapeHtml(event.action)}${target}</code></td>
      <td class="dim">${escapeHtml(event.reason)}</td>
    </tr>`;
}

const EMPTY_ACTIVITY = `<tr><td colspan="5" class="empty">No decisions yet. Ask the runtime something from the Console tab.</td></tr>`;
