---
'@memnox/core': patch
'@memnox/proxy': patch
'@memnox/interceptors': patch
'memnox': patch
---

A kubectl short resource name such as `ns`, `deploy` or `persistentvolumeclaim`, and the `type/name` form, now resolves to the same action as the long name. A rule on `kubectl.delete-namespace` can no longer be stepped around by typing `kubectl delete ns/prod`.
