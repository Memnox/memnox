/** Minimal logging port so packages stay framework-free. */
export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}
