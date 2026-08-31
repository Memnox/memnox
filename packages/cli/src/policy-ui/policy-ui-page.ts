import { POLICY_UI_CSS } from './policy-ui-theme';
import { UI_PATH, UI_SESSION_HEADER } from './policy-ui.constants';

interface PolicyUiPackSummary {
  name: string;
  description: string;
  policyCount: number;
}

interface PolicyUiPageData {
  filePath: string;
  sessionToken: string;
  effects: readonly string[];
  /** The one effect that needs approvers, so the form does not restate the constant. */
  approvalEffect: string;
  modes: readonly string[];
  defaultMode: string;
  packs: readonly PolicyUiPackSummary[];
}

/** `</script` inside embedded data would end the block early; escaping `<` cannot. */
function embedJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

/** One document, no build step, no network. */
export function renderPolicyUiPage(data: PolicyUiPageData): string {
  const boot = embedJson({
    filePath: data.filePath,
    token: data.sessionToken,
    effects: data.effects,
    approvalEffect: data.approvalEffect,
    modes: data.modes,
    defaultMode: data.defaultMode,
    packs: data.packs,
    paths: UI_PATH,
    tokenHeader: UI_SESSION_HEADER,
  });

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Memnox — policy editor</title>
<style>${POLICY_UI_CSS}</style>
</head>
<body>
<header class="topbar">
  <span class="wordmark">memnox</span>
  <span class="sep"></span>
  <span>Policy editor</span>
  <span class="path" id="file-path"></span>
  <span class="spacer"></span>
  <span class="badge badge-muted mono" id="version-chip">—</span>
  <span class="meta" id="dirty-flag"></span>
  <button class="btn btn-ghost btn-icon" id="theme-toggle" type="button" title="Switch theme" aria-label="Switch theme">◐</button>
  <button class="btn btn-outline btn-sm" id="revert" type="button" disabled>Revert</button>
  <button class="btn btn-sm" id="save" type="button" disabled>Save to file</button>
</header>

<main class="layout">
  <aside class="sidebar stack">
    <section class="card">
      <div class="card-header row">
        <div>
          <div class="card-title">Rules</div>
          <div class="card-description" id="rule-count"></div>
        </div>
        <span class="spacer"></span>
        <button class="btn btn-sm" id="add-rule" type="button">+ New</button>
      </div>
      <ul class="rule-list" id="rule-list"></ul>
    </section>

    <section class="card">
      <div class="card-content stack">
        <div>
          <label class="label" for="pack">Start from a pack<span class="hint">adds rules you do not already have</span></label>
          <select class="select" id="pack"></select>
        </div>
        <div class="meta" id="pack-description"></div>
        <button class="btn btn-outline btn-sm" id="add-pack" type="button">Add pack rules</button>
      </div>
    </section>
  </aside>

  <div class="stack">
    <section class="card">
      <div class="card-content" id="editor"></div>
    </section>

    <section class="card">
      <div class="card-header row">
        <div class="panel-tabs" id="panel-tabs" role="tablist">
          <button type="button" role="tab" data-panel="issues" aria-selected="true">Validation</button>
          <button type="button" role="tab" data-panel="yaml" aria-selected="false">YAML</button>
          <button type="button" role="tab" data-panel="simulate" aria-selected="false">Simulate</button>
        </div>
      </div>
      <div class="card-content" id="panel"></div>
    </section>
  </div>
</main>

<div class="toast" id="toast" role="status" aria-live="polite"></div>

<script>
const BOOT = ${boot};
${CLIENT_SCRIPT}
</script>
</body>
</html>`;
}

/** Plain DOM construction, never innerHTML, and kept out of the template above. */
const CLIENT_SCRIPT = String.raw`
const LIST_FIELDS = {
  actions: 'Actions',
  targets: 'Targets',
  environments: 'Environments',
  agents: 'Agents',
  branches: 'Branches',
  workingDirectories: 'Working directories',
};
const ADVANCED_FIELDS = {
  models: 'Models',
  providers: 'Providers',
  dataClassifications: 'Data classifications',
  jurisdictions: 'Jurisdictions',
};
const FIELD_HINTS = {
  actions: 'required — "deploy.*", "database.delete"',
  targets: '"payment/*", "*drop table*"',
  environments: '"production", "staging"',
  agents: 'agent names this rule applies to',
  branches: '"main", "release/*"',
  workingDirectories: '"/srv/checkout/*"',
};
const EFFECT_LABEL = {
  allow: 'Allow',
  redact: 'Redact',
  require_approval: 'Require approval',
  block: 'Block',
};
const VALIDATE_DEBOUNCE_MS = 350;

const state = {
  project: undefined,
  policies: [],
  savedSnapshot: '[]',
  selected: -1,
  panel: 'issues',
  issues: [],
  yaml: '',
  simulation: null,
  simulating: false,
};

const $ = (id) => document.getElementById(id);

function el(tag, props, children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === undefined || value === null) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, String(value));
  }
  for (const child of children || []) {
    if (child === null || child === undefined) continue;
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

function replace(host, nodes) {
  host.replaceChildren();
  for (const node of nodes) if (node) host.append(node);
}

let toastTimer = 0;
function toast(message, tone) {
  const node = $('toast');
  node.textContent = message;
  node.dataset.tone = tone || 'info';
  node.dataset.open = 'true';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.dataset.open = 'false'; }, 4000);
}

async function api(path, body) {
  const init = {
    method: body === undefined ? 'GET' : 'POST',
    headers: { [BOOT.tokenHeader]: BOOT.token },
  };
  if (body !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const response = await fetch(path, init);
  const payload = await response.json();
  return { ok: response.ok, payload };
}

/* ── model helpers ───────────────────────────────────────────────────────── */

function currentPolicy() {
  return state.policies[state.selected];
}

function isDirty() {
  return JSON.stringify(state.policies) !== state.savedSnapshot;
}

function uniqueName(base) {
  const taken = new Set(state.policies.map((policy) => policy.name));
  if (!taken.has(base)) return base;
  let suffix = 2;
  while (taken.has(base + '-' + suffix)) suffix += 1;
  return base + '-' + suffix;
}

function blankPolicy() {
  return {
    name: uniqueName('new-rule'),
    match: { actions: [] },
    decision: { effect: BOOT.approvalEffect, approvers: [] },
  };
}

/* ── chip input ──────────────────────────────────────────────────────────── */

function chipInput(values, placeholder, onChange) {
  const host = el('div', { class: 'chips' }, []);

  const draw = () => {
    host.replaceChildren();
    values.forEach((value, index) => {
      host.append(el('span', { class: 'chip' }, [
        value,
        el('button', {
          type: 'button',
          'aria-label': 'Remove ' + value,
          text: '×',
          onclick: () => { values.splice(index, 1); draw(); onChange(values); },
        }, []),
      ]));
    });
    host.append(entry);
  };

  const commit = () => {
    const parts = entry.value.split(',').map((part) => part.trim()).filter(Boolean);
    if (parts.length === 0) return;
    for (const part of parts) if (!values.includes(part)) values.push(part);
    entry.value = '';
    draw();
    entry.focus();
    onChange(values);
  };

  const entry = el('input', { type: 'text', placeholder: placeholder, spellcheck: 'false' }, []);
  entry.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ',') { event.preventDefault(); commit(); return; }
    if (event.key === 'Backspace' && entry.value === '' && values.length > 0) {
      values.pop(); draw(); onChange(values);
    }
  });
  // A value typed but never confirmed is still a value the developer meant.
  entry.addEventListener('blur', commit);

  draw();
  return host;
}

function listField(container, key, label, hint) {
  const values = Array.isArray(container[key]) ? container[key] : [];
  return el('div', { class: 'field' }, [
    el('label', { class: 'label' }, [label, hint ? el('span', { class: 'hint', text: hint }, []) : null]),
    chipInput(values, 'type a pattern, press Enter', (next) => {
      if (next.length === 0) delete container[key];
      else container[key] = next;
      onEdit();
    }),
  ]);
}

function textField(label, value, placeholder, onInput) {
  const input = el('input', { class: 'input', type: 'text', placeholder: placeholder, spellcheck: 'false' }, []);
  input.value = value === undefined ? '' : value;
  input.addEventListener('input', () => onInput(input.value));
  return el('div', { class: 'field' }, [el('label', { class: 'label' }, [label]), input]);
}

function segmented(options, active, onPick) {
  return el('div', { class: 'segmented' }, options.map((option) =>
    el('button', {
      type: 'button',
      'aria-pressed': String(option.value === active),
      text: option.label,
      onclick: () => onPick(option.value),
    }, [])));
}

/* ── the rule form ───────────────────────────────────────────────────────── */

function renderEditor() {
  const host = $('editor');
  const policy = currentPolicy();
  if (policy === undefined) {
    replace(host, [el('div', { class: 'empty' }, [
      'No rule selected. Add one, or start from a pack.',
    ])]);
    return;
  }

  const match = policy.match;
  const decision = policy.decision;

  const header = el('div', { class: 'row', style: 'margin-bottom:1.25rem' }, [
    el('span', { class: 'dot effect-' + decision.effect }, []),
    el('strong', { text: policy.name || 'unnamed rule' }, []),
    el('span', { class: 'spacer' }, []),
    el('button', { class: 'btn btn-outline btn-sm', type: 'button', text: 'Duplicate', onclick: duplicateRule }, []),
    el('button', { class: 'btn btn-destructive btn-sm', type: 'button', text: 'Delete', onclick: deleteRule }, []),
  ]);

  const identity = el('div', { class: 'section' }, [
    el('div', { class: 'field-row' }, [
      textField('Name', policy.name, 'production-deploy-approval', (value) => {
        policy.name = value; onEdit(); renderList();
      }),
      textField('Description', policy.description, 'Why this rule exists', (value) => {
        if (value === '') delete policy.description; else policy.description = value;
        onEdit();
      }),
    ]),
  ]);

  const matchSection = el('div', { class: 'section' }, [
    el('p', { class: 'section-title', text: 'Matches when' }, []),
    ...Object.entries(LIST_FIELDS).map(([key, label]) =>
      listField(match, key, label, FIELD_HINTS[key])),
    argumentsField(match),
    windowsNote(match),
    el('details', { class: 'advanced' }, [
      el('summary', { text: 'More match fields' }, []),
      ...Object.entries(ADVANCED_FIELDS).map(([key, label]) =>
        listField(match, key, label, undefined)),
    ]),
  ]);

  const decisionSection = el('div', { class: 'section' }, [
    el('p', { class: 'section-title', text: 'Then' }, []),
    el('div', { class: 'field' }, [
      el('label', { class: 'label' }, ['Effect']),
      segmented(
        BOOT.effects.map((effect) => ({ value: effect, label: EFFECT_LABEL[effect] || effect })),
        decision.effect,
        (value) => { decision.effect = value; onEdit(); renderList(); renderEditor(); },
      ),
    ]),
    textField('Reason', decision.reason, 'Shown to the agent and written to the audit trail', (value) => {
      if (value === '') delete decision.reason; else decision.reason = value;
      onEdit();
    }),
    decision.effect === BOOT.approvalEffect ? approvalFields(decision) : null,
    el('details', { class: 'advanced' }, [
      el('summary', { text: 'Rollout and rate limit' }, []),
      el('div', { class: 'field' }, [
        el('label', { class: 'label' }, [
          'Mode',
          el('span', { class: 'hint', text: 'monitor records the match without deciding' }, []),
        ]),
        segmented(
          BOOT.modes.map((mode) => ({ value: mode, label: mode })),
          decision.mode === undefined ? BOOT.defaultMode : decision.mode,
          (value) => {
            if (value === BOOT.defaultMode) delete decision.mode; else decision.mode = value;
            onEdit(); renderList(); renderEditor();
          },
        ),
      ]),
      rateLimitField(decision),
    ]),
  ]);

  replace(host, [header, identity, matchSection, decisionSection]);
}

function approvalFields(decision) {
  const approvers = Array.isArray(decision.approvers) ? decision.approvers : [];
  const quorum = el('input', { class: 'input', type: 'number', min: '1', step: '1', placeholder: '1' }, []);
  quorum.value = decision.minApprovals === undefined ? '' : String(decision.minApprovals);
  quorum.addEventListener('input', () => {
    const parsed = Number.parseInt(quorum.value, 10);
    if (Number.isInteger(parsed) && parsed >= 1) decision.minApprovals = parsed;
    else delete decision.minApprovals;
    onEdit();
  });

  return el('div', { class: 'field-row' }, [
    el('div', { class: 'field' }, [
      el('label', { class: 'label' }, [
        'Approvers',
        el('span', { class: 'hint', text: 'required' }, []),
      ]),
      chipInput(approvers, 'eng-lead', (next) => {
        if (next.length === 0) delete decision.approvers; else decision.approvers = next;
        onEdit();
      }),
    ]),
    el('div', { class: 'field' }, [
      el('label', { class: 'label' }, [
        'Distinct approvals',
        el('span', { class: 'hint', text: 'default 1' }, []),
      ]),
      quorum,
    ]),
  ]);
}

function rateLimitField(decision) {
  const limit = decision.rateLimit;
  const max = el('input', { class: 'input', type: 'number', min: '1', step: '1', placeholder: 'no cap' }, []);
  const seconds = el('input', { class: 'input', type: 'number', min: '1', step: '1', placeholder: 'seconds' }, []);
  max.value = limit === undefined ? '' : String(limit.max);
  seconds.value = limit === undefined ? '' : String(limit.windowSeconds);

  const sync = () => {
    const maxValue = Number.parseInt(max.value, 10);
    const windowValue = Number.parseInt(seconds.value, 10);
    if (Number.isInteger(maxValue) && Number.isInteger(windowValue)) {
      decision.rateLimit = { max: maxValue, windowSeconds: windowValue };
    } else {
      delete decision.rateLimit;
    }
    onEdit();
  };
  max.addEventListener('input', sync);
  seconds.addEventListener('input', sync);

  return el('div', { class: 'field-row' }, [
    el('div', { class: 'field' }, [el('label', { class: 'label' }, ['Max firings']), max]),
    el('div', { class: 'field' }, [el('label', { class: 'label' }, ['Per window (seconds)']), seconds]),
  ]);
}

function argumentsField(match) {
  const entries = Object.entries(match.arguments === undefined ? {} : match.arguments);

  const rows = entries.map(([name, patterns]) => {
    const nameInput = el('input', { class: 'input', type: 'text', spellcheck: 'false' }, []);
    nameInput.value = name;
    nameInput.addEventListener('change', () => {
      const next = nameInput.value.trim();
      const bag = match.arguments;
      if (next === '' || next === name || bag === undefined) { nameInput.value = name; return; }
      bag[next] = bag[name];
      delete bag[name];
      onEdit();
      renderEditor();
    });

    return el('div', { class: 'arg-row' }, [
      nameInput,
      chipInput([...patterns], '*rm -rf /*', (next) => {
        if (next.length === 0) delete match.arguments[name];
        else match.arguments[name] = next;
        if (Object.keys(match.arguments).length === 0) delete match.arguments;
        onEdit();
      }),
      el('button', {
        class: 'btn btn-ghost btn-icon', type: 'button', text: '×',
        'aria-label': 'Remove argument ' + name,
        onclick: () => {
          delete match.arguments[name];
          if (Object.keys(match.arguments).length === 0) delete match.arguments;
          onEdit(); renderEditor();
        },
      }, []),
    ]);
  });

  return el('div', { class: 'field' }, [
    el('label', { class: 'label' }, [
      'Call arguments',
      el('span', { class: 'hint', text: 'matched in-process by the MCP firewall' }, []),
    ]),
    ...rows,
    el('button', {
      class: 'btn btn-outline btn-sm', type: 'button', text: '+ argument',
      onclick: () => {
        if (match.arguments === undefined) match.arguments = {};
        let name = 'command';
        let suffix = 2;
        while (match.arguments[name] !== undefined) { name = 'argument-' + suffix; suffix += 1; }
        match.arguments[name] = [];
        renderEditor();
      },
    }, []),
  ]);
}

/** Time windows stay in the file untouched: a schedule needs a calendar, not a text box. */
function windowsNote(match) {
  if (!Array.isArray(match.windows) || match.windows.length === 0) return null;
  return el('p', { class: 'meta' }, [
    match.windows.length + ' time window(s) on this rule are kept as written — edit them in the YAML file.',
  ]);
}

/* ── list, header, panels ────────────────────────────────────────────────── */

function renderList() {
  const host = $('rule-list');
  $('rule-count').textContent = state.policies.length + ' in ' + BOOT.filePath;

  if (state.policies.length === 0) {
    replace(host, [el('li', {}, [el('div', { class: 'empty' }, ['No rules yet.'])])]);
    return;
  }

  replace(host, state.policies.map((policy, index) =>
    el('li', {}, [
      el('button', {
        type: 'button',
        'aria-current': String(index === state.selected),
        onclick: () => { state.selected = index; renderList(); renderEditor(); },
      }, [
        el('span', { class: 'dot effect-' + policy.decision.effect }, []),
        el('span', { class: 'rule-name', text: policy.name || 'unnamed rule' }, []),
        policy.decision.mode === 'observe' ? el('span', { class: 'observe', text: 'observe' }, []) : null,
      ]),
    ])));
}

function renderHeader() {
  const dirty = isDirty();
  $('dirty-flag').textContent = dirty ? 'unsaved changes' : '';
  $('save').disabled = !dirty;
  $('revert').disabled = !dirty;
}

function renderPanel() {
  const host = $('panel');
  for (const tab of document.querySelectorAll('#panel-tabs button')) {
    tab.setAttribute('aria-selected', String(tab.dataset.panel === state.panel));
  }

  if (state.panel === 'issues') {
    if (state.issues.length === 0) {
      replace(host, [el('p', { class: 'meta', text: 'Every rule is valid.' }, [])]);
      return;
    }
    replace(host, [el('ul', { class: 'issues' },
      state.issues.map((issue) => el('li', { text: issue }, [])))]);
    return;
  }

  if (state.panel === 'yaml') {
    replace(host, [
      el('p', { class: 'meta', text: 'Exactly what "Save to file" writes. Comments in the current file are not carried over.' }, []),
      el('pre', { class: 'yaml', text: state.yaml || '—' }, []),
    ]);
    return;
  }

  replace(host, [
    el('p', { class: 'meta' }, [
      'Replays your recent audit history through these rules and reports what would be decided differently. Needs a runtime running.',
    ]),
    el('button', {
      class: 'btn btn-sm', type: 'button',
      text: state.simulating ? 'Replaying…' : 'Replay history',
      disabled: state.simulating ? 'disabled' : null,
      onclick: runSimulation,
    }, []),
    simulationResult(),
  ]);
}

function simulationResult() {
  const result = state.simulation;
  if (result === null) return null;
  if (result.available === false) {
    return el('p', { class: 'meta', style: 'margin-top:1rem', text: result.reason }, []);
  }

  const summary = el('div', { class: 'row', style: 'margin-top:1rem' }, [
    el('span', { class: 'badge badge-outline', text: result.total + ' actions replayed' }, []),
    el('span', { class: 'badge badge-outline', text: result.unchanged + ' unchanged' }, []),
    ...Object.entries(result.candidateTotals).map(([effect, count]) =>
      el('span', { class: 'badge effect-' + effect, text: (EFFECT_LABEL[effect] || effect) + ' ' + count }, [])),
  ]);

  if (result.changes.length === 0) {
    return el('div', {}, [summary, el('p', { class: 'meta', text: 'No action would be decided differently.' }, [])]);
  }

  const looser = result.changes.filter((change) => !change.stricter).length;
  const table = el('table', { class: 'changes' }, [
    el('thead', {}, [el('tr', {}, [
      el('th', { text: 'Action' }, []),
      el('th', { text: 'Was' }, []),
      el('th', { text: 'Becomes' }, []),
      el('th', { text: 'Rules' }, []),
    ])]),
    el('tbody', {}, result.changes.slice(0, 50).map((change) => el('tr', {}, [
      el('td', { class: 'case', text: [change.case.action, change.case.target, change.case.environment].filter(Boolean).join(' ') }, []),
      el('td', {}, [el('span', { class: 'badge effect-' + change.before, text: EFFECT_LABEL[change.before] || change.before }, [])]),
      el('td', {}, [el('span', { class: 'badge effect-' + change.after, text: EFFECT_LABEL[change.after] || change.after }, [])]),
      el('td', { class: 'meta', text: change.matchedPolicies.join(', ') }, []),
    ]))),
  ]);

  return el('div', { style: 'margin-top:1rem' }, [
    summary,
    looser > 0
      ? el('p', { class: 'meta', text: looser + ' action(s) become MORE permissive under these rules.' }, [])
      : null,
    table,
  ]);
}

/* ── actions ─────────────────────────────────────────────────────────────── */

let validateTimer = 0;
function onEdit() {
  renderHeader();
  // A replay describes the rules as they were when it ran, not as they are now.
  state.simulation = null;
  clearTimeout(validateTimer);
  validateTimer = setTimeout(validate, VALIDATE_DEBOUNCE_MS);
}

async function validate() {
  const { payload } = await api(BOOT.paths.VALIDATE, {
    project: state.project,
    policies: state.policies,
  });
  state.issues = payload.issues === undefined ? [] : payload.issues;
  state.yaml = payload.yaml === undefined ? '' : payload.yaml;
  $('version-chip').textContent = payload.version === undefined ? '—' : payload.version;
  renderPanel();
}

async function save() {
  const { ok, payload } = await api(BOOT.paths.SAVE, {
    project: state.project,
    policies: state.policies,
  });
  if (!ok) {
    state.issues = payload.issues === undefined ? [payload.error] : payload.issues;
    state.panel = 'issues';
    renderPanel();
    toast('Not saved — ' + state.issues.length + ' problem(s) to fix.', 'error');
    return;
  }
  state.policies = payload.policies;
  state.savedSnapshot = JSON.stringify(payload.policies);
  state.issues = [];
  state.yaml = payload.yaml;
  $('version-chip').textContent = payload.version;
  renderHeader(); renderList(); renderEditor(); renderPanel();
  toast('Saved ' + payload.policyCount + ' rules to ' + BOOT.filePath);
}

async function revert() {
  state.policies = JSON.parse(state.savedSnapshot);
  if (state.selected >= state.policies.length) state.selected = state.policies.length - 1;
  renderHeader(); renderList(); renderEditor();
  await validate();
}

async function runSimulation() {
  state.simulating = true;
  renderPanel();
  const { payload } = await api(BOOT.paths.SIMULATE, {
    project: state.project,
    policies: state.policies,
  });
  state.simulating = false;
  state.simulation = payload;
  renderPanel();
}

function addRule() {
  state.policies.push(blankPolicy());
  state.selected = state.policies.length - 1;
  onEdit(); renderList(); renderEditor();
}

function duplicateRule() {
  const policy = currentPolicy();
  if (policy === undefined) return;
  const copy = JSON.parse(JSON.stringify(policy));
  copy.name = uniqueName(policy.name + '-copy');
  state.policies.splice(state.selected + 1, 0, copy);
  state.selected += 1;
  onEdit(); renderList(); renderEditor();
}

function deleteRule() {
  const policy = currentPolicy();
  if (policy === undefined) return;
  if (!window.confirm('Delete "' + policy.name + '"?')) return;
  state.policies.splice(state.selected, 1);
  state.selected = Math.min(state.selected, state.policies.length - 1);
  onEdit(); renderList(); renderEditor();
}

async function addPack() {
  const name = $('pack').value;
  const { ok, payload } = await api(BOOT.paths.PACK, { pack: name, policies: state.policies });
  if (!ok) { toast(payload.error, 'error'); return; }
  if (payload.added.length === 0) { toast('Every rule in that pack is already here.'); return; }
  state.policies = payload.policies;
  state.selected = state.policies.length - payload.added.length;
  onEdit(); renderList(); renderEditor();
  toast('Added ' + payload.added.length + ' rules — review them, then save.');
}

/* ── boot ────────────────────────────────────────────────────────────────── */

function wire() {
  $('file-path').textContent = BOOT.filePath;
  $('add-rule').addEventListener('click', addRule);
  $('save').addEventListener('click', save);
  $('revert').addEventListener('click', revert);
  $('add-pack').addEventListener('click', addPack);

  const packs = $('pack');
  replace(packs, BOOT.packs.map((pack) =>
    el('option', { value: pack.name, text: pack.name + ' (' + pack.policyCount + ')' }, [])));
  const describePack = () => {
    const chosen = BOOT.packs.find((pack) => pack.name === packs.value);
    $('pack-description').textContent = chosen === undefined ? '' : chosen.description;
  };
  packs.addEventListener('change', describePack);
  describePack();

  for (const tab of document.querySelectorAll('#panel-tabs button')) {
    tab.addEventListener('click', () => { state.panel = tab.dataset.panel; renderPanel(); });
  }

  $('theme-toggle').addEventListener('click', () => {
    const dark = document.documentElement.dataset.theme === 'dark'
      || (document.documentElement.dataset.theme === undefined
        && window.matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.dataset.theme = dark ? 'light' : 'dark';
  });

  window.addEventListener('beforeunload', (event) => {
    if (!isDirty()) return;
    event.preventDefault();
    event.returnValue = '';
  });
}

async function boot() {
  wire();
  const { ok, payload } = await api(BOOT.paths.DOCUMENT);
  if (!ok) { toast(payload.error, 'error'); return; }
  state.project = payload.document.project;
  state.policies = payload.document.policies;
  state.savedSnapshot = JSON.stringify(state.policies);
  state.selected = state.policies.length > 0 ? 0 : -1;
  renderHeader(); renderList(); renderEditor();
  await validate();
}

boot();
`;
