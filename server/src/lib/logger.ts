/**
 * PHI-safe logger utility for application services and circuit breakers.
 */
export const logger = {
  info: (message: string, ...args: any[]): void => {
    console.log(`[INFO] ${message}`, ...args);
  },
  warn: (message: string, ...args: any[]): void => {
    console.warn(`[WARN] ${message}`, ...args);
  },
  error: (message: string, ...args: any[]): void => {
    console.error(`[ERROR] ${message}`, ...args);
  },
};
