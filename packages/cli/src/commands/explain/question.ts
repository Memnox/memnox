/** Answering a typed question: what is technically possible, what the runtime allows, and what a rule says. */

import { LocalGate, actionForVerb } from '@memnox/core';
import type {
  CapabilityInventory,
  InventoryAgent,
  InventoryTool,
  ParsedQuestion,
  PolicySet,
} from '@memnox/core';
import type { CliContext } from '../../cli-context';

interface Answer {
  technically: string;
  runtime: string;
  policy: string;
}

/** What one agent holds that bears on the question. */
interface Reach {
  agent: InventoryAgent;
  shell: boolean;
  tools: InventoryTool[];
}

/**
 * Three rows, each answered from something on this disk. The fourth, what the
 * organization intended, is the cloud's, so it is left out rather than guessed.
 */
export async function answerQuestion(
  question: ParsedQuestion,
  inventory: CapabilityInventory,
  rules: PolicySet,
  here: string,
): Promise<Answer> {
  const agent = resolveAskedAgent(question, inventory);
  const reach: Reach = {
    agent,
    shell: inventory.shell.includes(agent.id),
    tools: inventory.tools.filter((tool) =>
      inventory.mcpServers.some(
        (server) => server.name === tool.server && server.reachedBy.includes(agent.id),
      ),
    ),
  };
  return {
    technically: describeTechnically(question, inventory, reach),
    runtime: reach.shell
      ? 'a shell is present, so the runtime restricts nothing by itself'
      : `${reach.tools.length} tool(s) across ${inventory.mcpServers.length} server(s)`,
    policy: describePolicy(question, agent, rules, here),
  };
}

function resolveAskedAgent(
  question: ParsedQuestion,
  inventory: CapabilityInventory,
): InventoryAgent {
  const agent = inventory.agents.find((each) =>
    each.kind.toLowerCase().includes(question.agent.toLowerCase()),
  );
  if (agent !== undefined) return agent;
  const known = inventory.agents.map((each) => each.kind);
  throw new Error(
    known.length === 0
      ? `No agent on this machine, so there is nothing to answer about "${question.agent}".`
      : `No agent here matches "${question.agent}". Found: ${known.join(', ')}.`,
  );
}

function describeTechnically(
  question: ParsedQuestion,
  inventory: CapabilityInventory,
  reach: Reach,
): string {
  const { agent, tools } = reach;
  const path = inventory.filesystem.find(
    (entry) =>
      entry.reachableBy.includes(agent.id) && entry.path.includes(question.resource),
  );
  if (path !== undefined) return `yes, ${path.path} is reachable by ${agent.kind}`;
  if (reach.shell)
    return `yes, ${agent.kind} holds a shell, which reaches anything you can`;
  if (tools.length > 0) {
    return `unclear, ${tools.length} tool(s) reachable, none named for ${question.resource}`;
  }
  return `no, nothing ${agent.kind} holds here reaches ${question.resource}`;
}

/** Every file in force rather than this directory's, or a governed machine reads as ungoverned. */
function describePolicy(
  question: ParsedQuestion,
  agent: InventoryAgent,
  rules: PolicySet,
  here: string,
): string {
  if (rules.policies.length === 0) {
    return `no rules at ${here}, so nothing here would stop it`;
  }
  const gate = new LocalGate(rules.policies, { agentName: agent.kind });
  const verdict = gate.evaluate({
    action: actionForVerb(question.verb),
    target: question.resource,
  });
  const rule = verdict.matchedPolicies[0];
  const named = rule === undefined ? 'no rule matched' : `rule ${rule.name}`;
  return `${verdict.effect.toUpperCase()} by ${named}: ${verdict.reason}`;
}

export function renderAnswer(
  context: CliContext,
  question: ParsedQuestion,
  answer: Answer,
): void {
  const { flow } = context;
  flow.rows(`Can ${question.agent} ${question.verb} ${question.resource}?`, [
    { label: 'technically', value: answer.technically },
    { label: 'runtime', value: answer.runtime },
    { label: 'policy', value: answer.policy },
  ]);
  flow.close(answer.policy);
  // The fourth row is the cloud's, and an empty row is better than an invented one.
  flow.hint(
    'What the organization intended is not on this disk, so it is not answered here.',
  );
}
