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
