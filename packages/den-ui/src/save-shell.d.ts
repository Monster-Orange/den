/** den-ui 0.10.0 (issue 394): a rail change saved so that leaving the page can't lose it. */
export interface SaveShellOptions {
  /** Headers for the fetch (a CSRF token); a beacon can't carry them. */
  headers?: Record<string, string>;
  /** When the change was made, in ms (default now): the server keeps the newer save. */
  changedAt?: number;
}
/**
 * POSTs { shell: { ...patch, changedAt } } with keepalive; if the page hides
 * before it is confirmed, sends it again with navigator.sendBeacon (a JSON
 * Blob). Answers true when saved, else false; never throws.
 */
export declare function saveShell(
  url: string,
  patch: Record<string, unknown>,
  opts?: SaveShellOptions,
): Promise<boolean>;
