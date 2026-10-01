---
'@memnox/core': patch
'@memnox/proxy': patch
'@memnox/interceptors': patch
'memnox': patch
---

`memnox protect --apply-native` and `--revert-native` no longer crash on a Claude Code or OpenClaw settings file that holds `null`, an array, or a string where a permission list belongs. The file is left exactly as it was, and the refusal names it and says what is wrong with it.
