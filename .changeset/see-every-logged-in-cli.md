---
'@memnox/core': patch
'@memnox/proxy': patch
'@memnox/interceptors': patch
'memnox': patch
---

A scan reports every CLI that is logged in, not only aws. A CLI counted only when a credential file it found ended with the path its verb table named, and the tables named directories (`~/.config/gcloud`, `~/.netlify`), a path that holds nothing (`~/.heroku`), or files the scan never read (`~/.pgpass`, `~/.my.cnf`). With all six present, `authenticatedClis` reported aws alone. A table's credential now matches the file itself or the directory it sits in, Heroku is read from `~/.netrc` where its CLI writes the token, and the scan reads `.pgpass`, `.my.cnf`, gcloud's application default credentials, Azure's token cache and Pulumi's credentials. A test now holds every table's credential to a file the scan reads, so the two lists cannot drift apart again. Structure only, as before: no value is read out.
