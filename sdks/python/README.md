# memnox (Python SDK)

Standard-library-only client for the Memnox runtime.

```python
from memnox import MemnoxClient, ActionBlockedError

memnox = MemnoxClient(token="mnx_...")

decision = memnox.check("database.delete", target="users", environment="production")
print(decision.effect)  # "block"

# Or wrap the dangerous work — it only runs if the runtime allows it.
try:
    memnox.guard("deploy.service", lambda: deploy(), environment="production")
except ActionBlockedError as err:
    print(err.decision.reason)
```

## Asking the organization

`MemnoxClient` above asks the runtime whether an action **breaks a rule**.
`MemnoxOrganization` asks a different question — whether it **should happen**:
who owns it, what the company already decided, who authorizes it at this size,
and how much of the evidence this agent is entitled to see.

Separate service, separate credential, so it is a separate object.

```python
from memnox import MemnoxOrganization, may_proceed

org = MemnoxOrganization(token=os.environ["MEMNOX_GRANT"], workspace="acme")

answer = org.evaluate(
    "payment.refund",
    resource={"type": "customer", "id": "c_481"},
    principal="sarah@acme.test",
    amount=4500,
    reads=fact_ids,
)

if may_proceed(answer):
    stripe.Refund.create(...)
else:
    # answer.decision is one of allow, deny, ask, escalate, delegate, clarify.
    # answer.approvers names who can authorize it, and why they can.
    ...
```

| Call | Question |
|---|---|
| `evaluate` | Should this happen, and what may I know while doing it |
| `context` | What does the company know that bears on this |
| `owner` | Who owns this, and through which decision |
| `decisions` | What has already been decided about this topic |
| `agents_for` | Which agents this company runs for an action |
| `precedent` | What happened the last times this action was asked about |
| `can_share` | May I repeat this to them |
| `require` | Evaluate, and raise unless it is a plain allow |

Three things worth doing: send `reads` (the fact ids you rely on are what
produce a delegation rather than a refusal), read `withheld` (non-zero means
your answer is partial and you do not know how), and carry `constraints` into
your prompt (a model that was never told a limit cannot respect it).

It never fails open. A call that cannot reach Memnox raises
`OrganizationUnreachableError` rather than returning a permissive default —
catching that and proceeding turns an outage into the most permissive state in
your system.
