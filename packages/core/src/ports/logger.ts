/** Minimal logging port so packages stay framework-free. */
export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export const SILENT_LOGGER: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
