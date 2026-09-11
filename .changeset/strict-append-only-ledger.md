---
'@memnox/core': patch
'@memnox/interceptors': patch
---

The ledger's append-only trigger now holds what it claimed.

It asked only whether `authorizedBy` moved the right way, so any `UPDATE` that
set it could rewrite every other column in the same statement: one release of a
held call could turn a denied action into an allowed one, under a different name
and with a different reason, and SQLite raised nothing. `memnox why` reads those
rows a year later, which is the whole reason the trigger exists. Migration 4
recreates it so that nothing except `authorizedBy` may change, and a test holds
the guarded column list against the table itself so a column added later cannot
slip out from under it.

The git credential seam now carries an allow list rather than a deny list.
`protocol`, `host`, `path` and `username` are what naming a remote needs; every
other field git sends is dropped unread. The old list named `password` and
`credential`, which was right for the protocol as it stood and wrong as a shape,
since the block is extensible and already carries `oauth_refresh_token`. What
the seam carries reaches the ledger, so a list of what is safe is the only shape
that cannot be outgrown.
