---
"@memnox/interceptors": patch
"@memnox/core": patch
"@memnox/proxy": patch
"memnox": patch
---

A rule can name what a change does rather than only its class: `capabilities` matches `transfer` for anything that moves money, `deploy` for a deploy, a release, `kubectl apply` or `terraform apply`, `admin` for IAM, secrets, roles and invites, `execute` for code run somewhere else, and `delete`, `send`, `write` and `read`. It is read from the action's name and class, the same way for an MCP tool and a CLI verb, and a local command such as `git apply` stays a `write`. `memnox explain <server>` shows what each tool does in these words.
