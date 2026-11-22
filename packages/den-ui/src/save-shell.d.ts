/** den-ui 0.10.0 (issue 394): a rail change saved so that leaving the page can't lose it. */
export interface SaveShellOptions {
  /** Headers for the fetch (a CSRF token); a beacon can't carry them. */
  headers?: Record<string, string>;
  /** When the change was made, in ms (default now): the server keeps the newer save. */
  changedAt?: number;
  /** den-ui 0.11.0: keep the save here until an answer comes back (pendingOver). */
  pending?: PendingStore;
}
/** den-ui 0.11.0: where unanswered saves are kept, and whose they are. */
export interface PendingStore {
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  key: string;
  /** Who made the saves (a login), if known. */
  who?: string | null;
}
/** An unanswered save older than this (10 min) is dropped. */
export declare const PENDING_MAX_AGE_MS: number;
/**
 * The server's shell block with this browser's unanswered saves over it,
 * dropping any that are too old, beaten by a newer save of the key on the
 * server (`stamps`), or someone else's; and the saves to send again.
 */
export declare function pendingOver(
  store: PendingStore,
  shell: Record<string, unknown> | null | undefined,
  stamps: Record<string, number> | null | undefined,
  now?: number,
): {
  shell: Record<string, unknown>;
  resend: { patch: Record<string, unknown>; at: number }[];
};
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
