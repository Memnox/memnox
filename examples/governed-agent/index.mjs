// A minimal governed agent: every side effect goes through the runtime first.
// Run: memnox serve --policies examples/policies/baseline.yaml   (in another shell)
//      node examples/governed-agent/index.mjs
import { MemnoxClient, ActionBlockedError, ApprovalRequiredError } from '@memnox/sdk';

const RUNTIME_URL = process.env.MEMNOX_URL ?? 'http://127.0.0.1:7466';
const admin = new MemnoxClient({ baseUrl: RUNTIME_URL });
const { token } = await admin.registerAgent('example-agent', 'custom');
const memnox = new MemnoxClient({ baseUrl: RUNTIME_URL, token });

async function attempt(description, request, work) {
  try {
    await memnox.guard(request, work);
    console.log(`ALLOWED  ${description}`);
  } catch (err) {
    if (err instanceof ActionBlockedError) {
      console.log(`BLOCKED  ${description} — ${err.decision.reason}`);
    } else if (err instanceof ApprovalRequiredError) {
      console.log(`PENDING  ${description} — approval ${err.decision.approvalId}`);
    } else {
      throw err;
    }
  }
}

await attempt('read the repository', { action: 'repository.read' }, async () => {});
await attempt(
  'drop the production database',
  { action: 'database.delete', target: 'users', environment: 'production' },
  async () => {},
);
await attempt(
  'deploy to production',
  { action: 'deploy.service', target: 'api', environment: 'production' },
  async () => {},
);
console.log('\nEvery attempt above is in the audit log: memnox audit');
