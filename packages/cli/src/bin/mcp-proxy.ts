/**
 * The proxy ships inside the `memnox` package rather than only in `@memnox/proxy`,
 * because npm exposes the bins of the package you installed and not those of its
 * dependencies. Without this, `memnox mcp wrap` would point every MCP server at a
 * binary the user does not have.
 */
import '@memnox/proxy/cli';
