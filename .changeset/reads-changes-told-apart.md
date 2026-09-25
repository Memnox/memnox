---
"@memnox/interceptors": patch
"@memnox/core": patch
"@memnox/proxy": patch
"memnox": patch
---

A shell line is split only where the shell splits it, so `psql -c "SELECT 1; DROP TABLE t"` is one statement that drops a table rather than a read followed by an unknown command. Every `-c` is read, and so is a heredoc or a here-string, a `DROP` of any object, `COPY ... FROM`, `SELECT ... INTO`, `DO`, `CALL` and `VACUUM`. A statement nothing recognises is a write, since a database session can do anything. `mongosh` is read by its method names, so `deleteMany({})` is every document and `find` is a read.

Writes the shell makes are ruled on as writes: a redirect, `tee`, `touch`, `mkdir`, `sed -i`, `chmod`, `ln`, `truncate`, both ends of `mv` and the destination of `cp`, and `rmdir`, `unlink` and `shred` are deletes.

Flags before the verb no longer hide it, so `kubectl --context prod delete`, `git -C dir push` and `aws --profile prod s3 rm` are the delete or push they are. `gh api -XPOST`, `--method=POST` and a lowercase method are writes, a GraphQL query is a read and a mutation a write, and an approving review is its own action. The `railway`, `stripe`, `npm`, `git`, `kubectl`, `terraform` and `docker` tables cover the verbs that were unknown and so let through, among them `railway redeploy`, `down` and `variables --set`, `stripe post`, `delete`, `trigger` and every resource's `create`, `update`, `confirm` and `capture`, and `npm ci`.

An MCP tool named `rerun`, `cancel`, `redeploy`, `refund` or `approve` is a write, a name that opens with a read verb stays a read whatever noun follows, and a database tool is judged by the statement it was handed. `memnox policy test` and `memnox next` rule with each action's class, so a rule about changes no longer shows a read as refused, and `policy test --class` names one.
