---
"@memnox/interceptors": patch
"@memnox/core": patch
"@memnox/proxy": patch
"memnox": patch
---

Reading never waits on a person, and changing somebody else's system still does. A web fetch, a search, `curl` or `wget` without a body goes through, and a `POST`, `PUT`, `PATCH` or `DELETE` is asked about. An MCP tool that lists or reads goes through, and one that writes, deletes, sends a message or cannot be classified is asked about. The CLIs that act on a remote system, which are the cloud providers, `gh`, `kubectl`, `terraform`, the hosting platforms, `stripe`, the database clients, `docker push` and `npm publish`, are asked about for their writes and deletes and left alone for their reads, while installs, builds and test runs stay local work. Rules gain a `classes` field for this, and an `http.request` names its `method`.

The `aws` table now reads an operation by its verb whatever the service, so `aws ec2 describe-instances` is a read and `create-`, `put-`, `update-`, `delete-` and the rest are changes, where before most of them matched nothing. `gh api` is a change when a method or a field says so, and the everyday `pr`, `issue`, `workflow` and `run` verbs are classified.

A refused edit tells the agent that a yes in the conversation allows nothing and that the same write made another way is the same write, and says how its person can allow it.
