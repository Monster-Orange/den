/** den-ui 0.10.0 (issue 394): a rail change saved so that leaving the page can't lose it. */
export interface SaveShellOptions {
  /** Headers for the fetch (a CSRF token); a beacon can't carry them. */
  headers?: Record<string, string>;
  /** When the change was made, in ms (default now): the server keeps the newer save. */
  changedAt?: number;
}
/** Browsers refuse a keepalive fetch or beacon body over this (64 KB). */
export declare const KEEPALIVE_MAX_BYTES: number;
/**
 * POSTs { shell: { ...patch, changedAt } } with keepalive; if the page hides
 * before it is confirmed, sends it again with navigator.sendBeacon (a JSON
 * Blob). A body over KEEPALIVE_MAX_BYTES goes as a plain fetch. Answers true when saved, else false; never throws.
 */
export declare function saveShell(
  url: string,
  patch: Record<string, unknown>,
  opts?: SaveShellOptions,
): Promise<boolean>;
