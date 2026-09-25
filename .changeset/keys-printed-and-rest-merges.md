---
"@memnox/interceptors": patch
"@memnox/core": patch
"@memnox/proxy": patch
"memnox": patch
---

Printing a key is ruled on as reading it. `env`, `printenv`, `export -p` and `set` print every variable, and `printenv NAME` or `echo $NAME` prints one, so each is an `environment.read` naming the variable, or `all`. Only a name that looks like a credential counts, and a key handed to `curl` is left to the egress check, since it is used there rather than shown. The generated rule about credential files covers these too.

`gh api -X PUT repos/<owner>/<repo>/pulls/<n>/merge` is `gh.pr-merge`, so a rule about merging is not stepped around through the REST API.
