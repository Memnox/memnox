/**
 * The proxy bin ships here as well as in `@memnox/proxy`, because npm exposes only the
 * installed package's bins, so `mcp wrap` would otherwise point at a missing binary.
 */
import '@memnox/proxy/cli';
