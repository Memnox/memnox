---
'@memnox/core': patch
'@memnox/proxy': patch
'@memnox/interceptors': patch
'memnox': patch
---

A wildcard in a rule pattern now spans a line break, the same way it already spanned `.` and `/`. `*` compiled to a regular expression whose `.` stopped at a newline, so a pattern matched a single-line value and not the multi-line one the rule author meant it to cover. Arguments are matched exactly as the agent sent them, deliberately, so a value that arrives carrying a line break reaches the matcher with it intact.
