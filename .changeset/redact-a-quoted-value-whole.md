---
'@memnox/core': patch
'@memnox/proxy': patch
'@memnox/interceptors': patch
'memnox': patch
---

A quoted credential is masked whole rather than to its first space. `--password="correct horse battery staple"` came back as `--password="[redacted] horse battery staple"`: the rules that mask a named value consumed the opening quote but stopped the value at whitespace, so everything after the first word stayed in the text that reaches a ledger row, a report or a screenshot. A partly masked value is worse than an unmasked one, because it reads as handled.

Both rules now run a quoted value to its closing quote on the same line, so a passphrase, a JSON string and `--password "a b c"` mask in full. Apostrophes inside double quotes and vice versa are covered; an unterminated quote falls back to the previous behaviour.
