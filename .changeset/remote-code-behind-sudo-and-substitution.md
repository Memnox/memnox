---
'@memnox/core': patch
'@memnox/proxy': patch
'@memnox/interceptors': patch
'memnox': patch
---

A download run as code is now held as hidden code when it is piped into `sudo bash` or a bare `python3`, `node`, `ruby`, `perl`, `fish` or `pwsh`, and when it is substituted in, as in `bash -c "$(curl ...)"` or `bash <(curl ...)`. Process substitutions are read as the commands they run rather than as files.
