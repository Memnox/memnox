# @memnox/sdk

The TypeScript client. Ask the runtime whether an action may proceed, before your
code does it.

```bash
npm install @memnox/sdk
```

## The one-line version

```ts
import { shouldExecute } from '@memnox/sdk';

if (await shouldExecute(client, 'database.delete', 'users', 'production')) {
  await db.users.deleteAll();
}
```

`canAccess`, `canDeploy`, `canModify`, and `canDelete` are the same shape for the
other common verbs.

## The full client

```ts
import { MemnoxClient } from '@memnox/sdk';

const client = new MemnoxClient({
  baseUrl: 'http://localhost:8787',
  token: process.env.MEMNOX_AGENT_TOKEN,
});

const decision = await client.check({
  action: 'deploy.production',
  target: 'api',
  environment: 'production',
});
```

`check` returns the decision. `checkOrThrow` raises `ActionBlockedError` or
`ApprovalRequiredError` instead, when a thrown error fits your control flow
better.

## Governing a tool registry

`governTool` and `governTools` wrap any function-calling registry — OpenAI Agents
SDK, Codex, LangGraph, CrewAI — so every tool invocation is checked first:

```ts
import { governTools } from '@memnox/sdk';

const guarded = governTools(client, tools, { environment: 'production' });
```

A blocked call returns the denial reason to the model rather than throwing, so the
agent can explain itself instead of crashing.

## Verified execution

`runGuarded` records what actually happened, not just what was permitted:

```ts
await runGuarded(client, request, {
  preconditions: [() => backupExists()],
  action: () => migrate(),
  postconditions: [() => rowCountMatches()],
  rollback: () => restore(),
});
```

The outcome is reported to `POST /v1/actions/outcome`, so the audit log shows
whether a permitted action succeeded — the gap most governance tools leave open.

A condition may return a measurement instead of a bare boolean, so the record
carries the number the check actually saw:

```ts
postconditions: [
  {
    description: 'no downtime',
    check: async () => {
      const seconds = await measureDowntime();
      return { held: seconds === 0, measurement: { name: 'downtime', value: seconds, unit: 's' } };
    },
  },
];
```

Measurements are the caller's testimony, recorded verbatim. The runtime cannot
observe downtime or customer impact and never derives them — it stores what the
caller measured and shows a decision whose outcome never arrived.

## Custom transport

Pass `fetch` to route requests through a proxy, a custom agent, or a test double:

```ts
new MemnoxClient({ baseUrl, token, fetch: myTransport });
```

## Errors

| Error | Meaning |
|---|---|
| `ActionBlockedError` | a policy blocked the action |
| `ApprovalRequiredError` | a human must approve; carries `approvalId` |
| `MemnoxApiError` | transport or server error, with the HTTP status |
