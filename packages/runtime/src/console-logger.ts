import type { Logger } from '@memnox/core';

/** Composition-root logger for the standalone server and CLI. */
export const CONSOLE_LOGGER: Logger = {
  info: (message) => console.log(`[memnox] ${message}`),
  warn: (message) => console.warn(`[memnox] ${message}`),
  error: (message) => console.error(`[memnox] ${message}`),
};
