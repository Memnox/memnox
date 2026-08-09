# Third-party notices

Memnox Runtime is Apache-2.0. The `all-in-one` image redistributes the software
below; these notices travel with it, as Apache-2.0 section 4 requires.

The default image (`Dockerfile`) contains none of this — Graphify is an optional
peer there, installed by the operator with `memnox graphify install`, and Memnox
reads the JSON it writes rather than linking against it.

---

## Graphify

- **Source:** https://github.com/Graphify-Labs/graphify
- **Package:** `graphifyy` on PyPI
- **Version:** pinned by the `GRAPHIFY_VERSION` build argument
- **Licence:** dual-licensed Apache-2.0 **or** MIT, at your option
- **Copyright:** © 2026 Safi Shamsi

Memnox invokes it as a separate process and reads the `graphify-out/graph.json`
it writes. There is no linking, and no Graphify code runs inside the runtime.

Only edges tagged `EXTRACTED` — parsed from the AST — are read. Edges tagged
`INFERRED` are counted and discarded, because a model-derived edge must never
influence a decision.

The full licence text ships in the image at `/app/LICENSE` (Apache-2.0) and is
available for Graphify at the repository above under `LICENSE` and `LICENSE-MIT`.

### Upstream security properties this image relies on

Stated in Graphify's own `SECURITY.md`:

- No network calls during analysis; egress only in `ingest`, with a URL the
  caller supplies. Memnox never invokes that path.
- AST parsing only — no code execution from source files, and no `shell=True`
  subprocess calls. This matters because the graph is built over repositories
  Memnox does not trust.
- No network listener by default, and no stored credentials.

**Caveat:** that policy names 0.3.x as the supported line while the published
package is 0.8.x. Treat it as a stale file rather than a support guarantee, and
pin the version you audited.

---

## Node.js base image

`node:20-bookworm-slim` and its Debian packages carry their own licences, listed
in the image under `/usr/share/doc/*/copyright`.
