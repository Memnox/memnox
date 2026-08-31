/** Plain DOM construction, never innerHTML: agent names and audit targets are untrusted. */
export const DASHBOARD_SCRIPT = String.raw`
'use strict';

var TOKEN_KEY = 'memnox.dashboard.token';
/** The console's own identity, so it never has to borrow another agent's. */
var CONSOLE_AGENT = 'dashboard-console';
var POLL_MS = 5000;

var state = {
  token: sessionStorage.getItem(TOKEN_KEY) || '',
  tab: 'activity',
  paused: false,
  policies: [],
  writable: null,
  timer: null,
};

/* ── plumbing ─────────────────────────────────────────────── */

function el(tag, attrs, children) {
  var node = document.createElement(tag);
  if (attrs) {
    Object.keys(attrs).forEach(function (key) {
      var value = attrs[key];
      if (value === undefined || value === null || value === false) return;
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else if (key.slice(0, 2) === 'on') node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value === true ? '' : String(value));
    });
  }
  (children || []).forEach(function (child) {
    if (child === null || child === undefined) return;
    node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  });
  return node;
}

function $(id) { return document.getElementById(id); }

function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

function toast(message, tone) {
  var box = $('toast');
  box.textContent = message;
  box.setAttribute('data-tone', tone || 'info');
  box.setAttribute('data-open', 'true');
  window.clearTimeout(box.dataset.timer);
  box.dataset.timer = window.setTimeout(function () {
    box.setAttribute('data-open', 'false');
  }, 4000);
}

function headers(withBody) {
  var out = {};
  if (withBody) out['content-type'] = 'application/json';
  if (state.token) out['authorization'] = 'Bearer ' + state.token;
  return out;
}

/** Every call goes through here so one 401 puts the whole page behind the gate. */
function api(method, path, body) {
  return fetch(path, {
    method: method,
    headers: headers(body !== undefined),
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then(function (response) {
    if (response.status === 401) {
      showGate();
      throw new Error('This runtime needs a management token.');
    }
    return response.text().then(function (text) {
      var parsed = null;
      try { parsed = text ? JSON.parse(text) : null; } catch (err) { parsed = null; }
      if (!response.ok) throw new Error(explain(parsed, text, response.status));
      return parsed;
    });
  });
}

/** Routes refuse in two shapes — one "error" string or an "errors" array. */
function explain(parsed, text, status) {
  if (parsed) {
    if (Array.isArray(parsed.errors) && parsed.errors.length > 0) {
      return parsed.errors.join(' · ').replace(/\n\s*-\s*/g, ': ');
    }
    if (typeof parsed.error === 'string') return parsed.error;
  }
  return text || 'The runtime refused that (' + status + ').';
}

function failed(err) { toast(err.message || String(err), 'bad'); }

function showGate() {
  $('app').classList.add('hidden');
  $('gate').classList.remove('hidden');
  stopPolling();
}

/* ── formatting ───────────────────────────────────────────── */

function time(iso) {
  var parsed = new Date(iso);
  return isNaN(parsed.getTime()) ? iso : parsed.toLocaleTimeString();
}

function verdict(effect, withheld) {
  var shown = withheld || effect;
  var label = shown.toUpperCase();
  var cell = el('span', { class: 'verdict verdict-' + shown, text: label });
  if (!withheld) return cell;
  return el('span', {}, [cell, el('span', { class: 'tag', text: 'withheld' })]);
}

function actionCell(action, target) {
  return el('code', { text: target ? action + ' ' + target : action });
}

function patterns(value) {
  return value.split(',').map(function (item) { return item.trim(); })
    .filter(function (item) { return item.length > 0; });
}

/* ── overview ─────────────────────────────────────────────── */

function paintStatus(status) {
  $('tile-policies').textContent = String(status.policyCount);
  $('tile-policies-hint').textContent = 'version ' + status.policyVersion;
  $('tile-decisions').textContent = String(status.recentDecisions);
  $('tile-approvals').textContent = String(status.pendingApprovals);
  $('tile-withheld').textContent = String(status.withheld);
  $('tile-approvals-card').classList.toggle('tile-attention', status.pendingApprovals > 0);
  $('tile-withheld-card').classList.toggle('tile-attention', status.withheld > 0);

  var observing = status.enforcement !== 'enforce';
  // The tab is rendered once by the server; without this it still reads
  // "enforce" after someone has switched the runtime to monitor.
  document.title = 'Memnox — ' + status.enforcement;
  var mode = $('mode');
  mode.textContent = observing ? 'observing' : 'enforcing';
  mode.className = 'mode ' + (observing ? 'mode-observing' : 'mode-enforcing');
  $('banner').classList.toggle('hidden', !observing);
  $('enforcement').value = status.enforcement;

  var badge = $('approvals-count');
  badge.textContent = String(status.pendingApprovals);
  badge.classList.toggle('attention', status.pendingApprovals > 0);

  var guards = $('guards');
  clear(guards);
  status.guards.forEach(function (guard) {
    guards.appendChild(el('li', { text: guard }));
  });

  var rows = $('activity-rows');
  clear(rows);
  if (status.recent.length === 0) {
    rows.appendChild(el('tr', {}, [
      el('td', { colspan: '5', class: 'empty', text: 'No decisions yet. Ask the runtime something from the Console tab.' }),
    ]));
    return;
  }
  status.recent.forEach(function (event) {
    rows.appendChild(el('tr', {}, [
      el('td', { class: 'n dim', text: time(event.occurredAt) }),
      el('td', {}, [verdict(event.effect, event.shadowEffect)]),
      el('td', { text: event.agentName }),
      el('td', {}, [actionCell(event.action, event.target)]),
      el('td', { class: 'dim', text: event.reason }),
    ]));
  });
}

/* ── approvals ────────────────────────────────────────────── */

function loadApprovals() {
  return api('GET', '/v1/approvals').then(function (pending) {
    var body = $('approvals-list');
    clear(body);
    if (!pending || pending.length === 0) {
      body.appendChild(el('p', { class: 'empty', text: 'Nothing is waiting on a human.' }));
      return;
    }
    pending.forEach(function (approval) { body.appendChild(approvalCard(approval)); });
  });
}

function approvalCard(approval) {
  var who = $('resolver');
  var facts = [
    ['Asked of', approval.approvers.join(', ')],
    ['Granted', approval.grants.length + '/' + approval.minApprovals],
  ];
  if (approval.amount !== undefined) facts.unshift(['Amount', String(approval.amount)]);
  if (approval.principal !== undefined) facts.unshift(['For', approval.principal]);
  if (approval.environment) facts.unshift(['Environment', approval.environment]);

  var resolve = function (approved) {
    return function () {
      var by = who.value.trim();
      if (!by) { toast('Say who is deciding.', 'bad'); who.focus(); return; }
      api('POST', '/v1/approvals/' + encodeURIComponent(approval.id), {
        approved: approved,
        resolvedBy: by,
      }).then(function (result) {
        toast(approval.action + ' ' + result.status + ' by ' + by, approved ? 'good' : 'info');
        return refresh();
      }).catch(failed);
    };
  };

  return el('div', { class: 'card' }, [
    el('div', { class: 'card-head' }, [
      el('h3', {}, [actionCell(approval.action, approval.target)]),
      el('span', { class: 'spacer' }),
      el('span', { class: 'tag', text: approval.id.slice(0, 8) }),
    ]),
    el('div', { class: 'card-body' }, [
      approval.reason ? el('p', { class: 'dim', text: approval.reason, style: 'margin:0' }) : null,
      el('div', { class: 'scroller' }, [
        el('table', {}, [
          el('tbody', {}, facts.map(function (fact) {
            return el('tr', {}, [
              el('th', { text: fact[0] }),
              el('td', { text: fact[1] }),
            ]);
          })),
        ]),
      ]),
      el('div', { class: 'actions' }, [
        el('button', { class: 'primary', text: 'Approve', onclick: resolve(true) }),
        el('button', { class: 'danger', text: 'Deny', onclick: resolve(false) }),
      ]),
    ]),
  ]);
}

/* ── policies ─────────────────────────────────────────────── */

function loadPolicies() {
  return api('GET', '/v1/policies').then(function (view) {
    state.policies = view.policies || [];
    // Sending the composed set back is refused for duplicate names.
    state.writable = view.writable === undefined ? null : view.writable;
    $('policy-form').classList.toggle('hidden', state.writable === null);
    var rows = $('policy-rows');
    clear(rows);
    if (state.policies.length === 0) {
      rows.appendChild(el('tr', {}, [
        el('td', { colspan: '4', class: 'empty', text: 'No rules yet. Add one below.' }),
      ]));
      return;
    }
    // Writable rules are claimed off by shape: an org rule can share a local one's name.
    var unclaimed = (state.writable || []).map(function (policy) { return JSON.stringify(policy); });
    state.policies.forEach(function (policy) {
      var match = policy.match || {};
      var at = unclaimed.indexOf(JSON.stringify(policy));
      var mine = at !== -1;
      if (mine) unclaimed.splice(at, 1);
      rows.appendChild(el('tr', {}, [
        el('td', {}, [
          el('code', { text: policy.name }),
          mine ? null : el('span', { class: 'tag', text: 'from your organization' }),
        ]),
        el('td', {}, [el('span', {
          class: 'verdict verdict-' + policy.decision.effect,
          text: policy.decision.effect.toUpperCase(),
        })]),
        el('td', { class: 'dim', text: describeMatch(match) }),
        el('td', {}, [
          // A rule this runtime did not write cannot be removed here. Offering
          // the button would delete the local copy and leave the rule in force.
          mine
            ? el('button', {
                class: 'ghost', text: 'Remove',
                onclick: function () { removePolicy(policy.name); },
              })
            : null,
        ]),
      ]));
    });
  });
}

function describeMatch(match) {
  var parts = [];
  if (match.actions) parts.push(match.actions.join(', '));
  if (match.targets) parts.push('on ' + match.targets.join(', '));
  if (match.environments) parts.push('in ' + match.environments.join(', '));
  return parts.length === 0 ? 'everything' : parts.join(' · ');
}

/** Resolves true when the rule set was applied, false when it was refused. */
function writePolicies(next, message) {
  return api('PUT', '/v1/policies', { version: 1, policies: next })
    .then(function (result) {
      toast(message + ' — now at version ' + result.version, 'good');
      return refresh().then(function () { return true; });
    })
    .catch(function (err) {
      failed(err);
      return false;
    });
}

function removePolicy(name) {
  var next = (state.writable || []).filter(function (policy) { return policy.name !== name; });
  writePolicies(next, 'Removed "' + name + '"');
}

function addPolicy(event) {
  event.preventDefault();
  var name = $('rule-name').value.trim();
  var actions = patterns($('rule-actions').value);
  if (!name || actions.length === 0) {
    toast('A rule needs a name and at least one action.', 'bad');
    return;
  }
  var effect = $('rule-effect').value;
  var approvers = patterns($('rule-approvers').value);
  // The rule the engine enforces anyway; saying it here saves a round trip.
  if (effect === 'escalate' && approvers.length === 0) {
    toast('Who approves it? A rule that requires approval has to name someone.', 'bad');
    $('rule-approvers').focus();
    return;
  }

  var match = { actions: actions };
  var targets = patterns($('rule-targets').value);
  var environments = patterns($('rule-environments').value);
  if (targets.length > 0) match.targets = targets;
  if (environments.length > 0) match.environments = environments;

  var decision = { effect: effect };
  var reason = $('rule-reason').value.trim();
  if (reason) decision.reason = reason;
  if (effect === 'escalate') decision.approvers = approvers;

  if (state.writable === null) {
    toast('This runtime cannot read the file it writes — fix it on disk first.', 'bad');
    return;
  }
  writePolicies(state.writable.concat([{ name: name, match: match, decision: decision }]),
    'Added "' + name + '"').then(function (applied) {
      // Only on success: a rejected rule leaves the form exactly as it was, so
      // the fix is one edit rather than typing all of it again.
      if (applied) $('policy-form').reset();
    });
}

/* ── decision memory ──────────────────────────────────────── */

function loadDecisions() {
  return api('GET', '/v1/memory/decisions').then(function (decisions) {
    var rows = $('decision-rows');
    clear(rows);
    if (!decisions || decisions.length === 0) {
      rows.appendChild(el('tr', {}, [
        el('td', { colspan: '5', class: 'empty', text: 'Nothing recorded. A decision here constrains what agents may do.' }),
      ]));
      return;
    }
    decisions.forEach(function (decision) {
      var status = decision.status || 'active';
      rows.appendChild(el('tr', {}, [
        el('td', { text: decision.title }),
        el('td', { class: 'dim', text: decision.owner }),
        el('td', {}, [el('code', { text: decision.actions.join(', ') })]),
        el('td', {}, [el('span', { class: 'tag', text: status })]),
        el('td', {}, [
          status === 'active'
            ? el('button', {
                class: 'ghost', text: 'Retire',
                onclick: function () { retireDecision(decision.id, decision.title); },
              })
            : null,
        ]),
      ]));
    });
  });
}

function retireDecision(id, title) {
  api('POST', '/v1/memory/decisions/' + encodeURIComponent(id) + '/status', { status: 'retired' })
    .then(function () {
      toast('"' + title + '" no longer constrains anything.', 'info');
      return loadDecisions();
    })
    .catch(failed);
}

function addDecision(event) {
  event.preventDefault();
  var payload = {
    title: $('decision-title').value.trim(),
    statement: $('decision-statement').value.trim(),
    owner: $('decision-owner').value.trim(),
    actions: patterns($('decision-actions').value),
    enforcement: $('decision-enforcement').value,
  };
  if (!payload.title || !payload.statement || !payload.owner || payload.actions.length === 0) {
    toast('Title, statement, owner and at least one action are required.', 'bad');
    return;
  }
  var environments = patterns($('decision-environments').value);
  if (environments.length > 0) payload.environments = environments;

  api('POST', '/v1/memory/decisions', payload)
    .then(function (record) {
      toast('Recorded "' + record.title + '".', 'good');
      $('decision-form').reset();
      return loadDecisions();
    })
    .catch(failed);
}

/* ── agents ───────────────────────────────────────────────── */

function loadAgents() {
  return api('GET', '/v1/agents').then(function (agents) {
    var rows = $('agent-rows');
    clear(rows);
    if (!agents || agents.length === 0) {
      rows.appendChild(el('tr', {}, [
        el('td', { colspan: '5', class: 'empty', text: 'No agents registered yet.' }),
      ]));
      return;
    }
    agents.forEach(function (agent) {
      var suspended = agent.status === 'suspended';
      rows.appendChild(el('tr', {}, [
        el('td', { text: agent.name }),
        el('td', { class: 'dim', text: agent.kind }),
        el('td', {}, [el('span', { class: 'tag' + (suspended ? ' alarm' : ''), text: agent.status })]),
        el('td', { class: 'n', text: agent.trustScore + '/100' }),
        el('td', {}, [el('button', {
          class: suspended ? 'ghost' : 'danger',
          text: suspended ? 'Reinstate' : 'Suspend',
          onclick: function () { setAgentStatus(agent.id, suspended ? 'active' : 'suspended', agent.name); },
        })]),
      ]));
    });
  });
}

function setAgentStatus(id, status, name) {
  api('POST', '/v1/agents/' + encodeURIComponent(id) + '/status', { status: status })
    .then(function () {
      toast(name + ' is now ' + status + '.', status === 'suspended' ? 'bad' : 'good');
      return loadAgents();
    })
    .catch(failed);
}

function registerAgent(event) {
  event.preventDefault();
  var name = $('agent-name').value.trim();
  if (!name) { toast('An agent needs a name.', 'bad'); return; }
  api('POST', '/v1/agents', { name: name, kind: $('agent-kind').value })
    .then(function (registered) {
      // Shown once, and only here: this is the last time the runtime can say it.
      $('agent-token').textContent =
        'Token for ' + registered.agent.name + ' (copy it now, it is never shown again):\n' + registered.token;
      $('agent-token').classList.remove('hidden');
      $('console-token').value = registered.token;
      $('agent-form').reset();
      return loadAgents();
    })
    .catch(failed);
}

/* ── console ──────────────────────────────────────────────── */

/** "memnox setup" registers an agent before a person ever opens this page. */
function issueConsoleToken() {
  var button = $('console-token-new');
  button.disabled = true;
  api('GET', '/v1/agents')
    .then(function (agents) {
      var mine = (agents || []).filter(function (agent) {
        return agent.name === CONSOLE_AGENT;
      })[0];
      return mine === undefined
        ? api('POST', '/v1/agents', { name: CONSOLE_AGENT, kind: 'custom' })
        : api('POST', '/v1/agents/' + encodeURIComponent(mine.id) + '/rotate');
    })
    .then(function (registered) {
      $('console-token').value = registered.token;
      toast('Asking as "' + registered.agent.name + '".', 'good');
      return loadAgents();
    })
    .catch(failed)
    .then(function () { button.disabled = false; });
}

function runCheck(event) {
  event.preventDefault();
  var token = $('console-token').value.trim();
  if (!token) { toast('No token yet — "Get a token" registers one for this console.', 'bad'); return; }
  var action = $('console-action').value.trim();
  if (!action) { toast('Which action?', 'bad'); return; }

  var payload = { action: action };
  var target = $('console-target').value.trim();
  var environment = $('console-environment').value.trim();
  var amount = $('console-amount').value.trim();
  if (target) payload.target = target;
  if (environment) payload.environment = environment;
  if (amount) payload.amount = Number(amount);

  fetch('/v1/actions/check', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
    body: JSON.stringify(payload),
  })
    .then(function (response) { return response.json(); })
    .then(function (decision) {
      var lines = [
        'Decision : ' + String(decision.effect || '').toUpperCase(),
        'Risk     : ' + decision.riskLevel,
        'Reason   : ' + decision.reason,
      ];
      if (decision.matchedPolicies && decision.matchedPolicies.length > 0) {
        lines.push('Policies : ' + decision.matchedPolicies.map(function (policy) {
          return policy.name;
        }).join(', '));
      }
      if (decision.approvalId) lines.push('Approval : ' + decision.approvalId);
      if (decision.shadowEffect) {
        lines.push('Withheld : ' + decision.shadowEffect + ' (this environment is only being observed)');
      }
      $('console-result').textContent = lines.join('\n');
      $('console-result').classList.remove('hidden');
      return refresh();
    })
    .catch(failed);
}

/* ── enforcement ──────────────────────────────────────────── */

/** Written out per mode: gluing "ing" on gave "enforceing" and "offing". */
var ENFORCEMENT_SAID = {
  off: 'Governance is off — no action is being decided on.',
  monitor: 'Now monitoring every environment. Decisions are recorded, nothing is withheld.',
  enforce: 'Now enforcing every environment.',
};

function setEnforcement() {
  var chosen = $('enforcement').value;
  api('PUT', '/v1/enforcement', { default: chosen })
    .then(function (result) {
      var said = ENFORCEMENT_SAID[result.default];
      toast(said || 'Mode is now ' + result.default + '.', result.default === 'off' ? 'bad' : 'good');
      return refresh();
    })
    .catch(failed);
}

/* ── tabs, polling, boot ──────────────────────────────────── */

var LOADERS = {
  activity: function () { return Promise.resolve(); },
  approvals: loadApprovals,
  policies: loadPolicies,
  decisions: loadDecisions,
  agents: loadAgents,
  console: function () { return Promise.resolve(); },
};

function selectTab(name) {
  state.tab = name;
  Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (tab) {
    tab.setAttribute('aria-selected', String(tab.dataset.tab === name));
  });
  Array.prototype.forEach.call(document.querySelectorAll('.pane'), function (panel) {
    panel.hidden = panel.dataset.panel !== name;
  });
  LOADERS[name]().catch(failed);
}

/** One pass: the numbers everyone sees, plus whatever the open tab shows. */
function refresh() {
  return api('GET', '/v1/status')
    .then(paintStatus)
    .then(function () { return LOADERS[state.tab](); })
    .catch(function (err) {
      // The gate already explains a 401; anything else is worth saying out loud.
      if (String(err.message).indexOf('management token') === -1) failed(err);
    });
}

function startPolling() {
  stopPolling();
  state.timer = window.setInterval(function () {
    if (!state.paused && !document.hidden) refresh();
  }, POLL_MS);
}

function stopPolling() {
  if (state.timer !== null) window.clearInterval(state.timer);
  state.timer = null;
}

function boot() {
  Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (tab) {
    tab.addEventListener('click', function () { selectTab(tab.dataset.tab); });
  });
  $('policy-form').addEventListener('submit', addPolicy);
  $('decision-form').addEventListener('submit', addDecision);
  $('agent-form').addEventListener('submit', registerAgent);
  $('console-form').addEventListener('submit', runCheck);
  $('console-token-new').addEventListener('click', issueConsoleToken);
  $('enforcement').addEventListener('change', setEnforcement);
  $('live').addEventListener('click', function () {
    state.paused = !state.paused;
    $('live').setAttribute('data-paused', String(state.paused));
    $('live').lastChild.textContent = state.paused ? 'paused' : 'live';
    if (!state.paused) refresh();
  });
  $('gate-form').addEventListener('submit', function (event) {
    event.preventDefault();
    state.token = $('gate-token').value.trim();
    sessionStorage.setItem(TOKEN_KEY, state.token);
    $('gate').classList.add('hidden');
    $('app').classList.remove('hidden');
    refresh().then(startPolling);
  });

  refresh().then(startPolling);
}

boot();
`;
