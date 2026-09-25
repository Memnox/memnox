---
"@memnox/interceptors": patch
"@memnox/core": patch
"@memnox/proxy": patch
"memnox": patch
---

A rule's `environments` now matches. A command's environment is the one it names, as it names it: railway's `--environment`, kubectl's `--context`, aws's `--profile`, gcloud's `--project`, docker's `--context`, and `RAILWAY_ENVIRONMENT`, `AWS_PROFILE`, `TF_WORKSPACE` or `DOCKER_CONTEXT` where no flag says. `vercel --prod`, `netlify --prod` and `stripe --live` are `production`, and an MCP call names its own in an `environment`, `environmentName`, `env` or `stage` argument. Before this, no seam set an environment, so a rule naming one never fired.

A refusal says which environment the command named, and where the rule only said to ask somebody it names the verb table's way forward for that command, such as `railway logs` for a refused `railway redeploy`. A shell command refused inside Claude Code's own shell tool now carries its way forward too, which it used to drop.
