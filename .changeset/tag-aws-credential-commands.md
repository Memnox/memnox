---
'@memnox/core': patch
'@memnox/proxy': patch
'@memnox/interceptors': patch
'memnox': patch
---

aws commands that hand back a credential are tagged as reading secrets. `ecr get-login-password`, `ssm get-parameter --with-decryption` and `sts get-session-token` fell into the generic `* get-**` read with no tag, and `sts assume-role`, `kms decrypt` and `configure get aws_secret_access_key` matched nothing at all and came out `aws.unknown`, so a rule written on secrets saw none of them. Each now has a row of its own, read and tagged `secrets`, and `configure set` is a write tagged the same.
