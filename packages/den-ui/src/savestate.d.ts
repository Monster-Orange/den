/** Save 800 ms after the last change. */
export declare const SAVE_AFTER_MS: number;
/** "Saving…" only when a save takes longer than this (400 ms). */
export declare const SAVING_AFTER_MS: number;
/** The first retries after a failure: 2 s, 4 s, 8 s. */
export declare const RETRY_MS: readonly number[];
/** Then a retry every 30 s. */
export declare const RETRY_EVERY_MS: number;

export type SaveStateName = "idle" | "saving" | "saved" | "error";

/** One change of state. announce: what a screen reader is told, if anything. */
export interface SaveStateChange {
  state: SaveStateName;
  /** saved: when it saved. */
  at?: Date;
  /** "error" on the first failure, "recovered" on the success after it. */
  announce: "error" | "recovered" | null;
}

/** The kit's words, replaced for this line only. {time} fills savedAt. */
export interface SaveStateWords {
  saving?: string;
  saved?: string;
  error?: string;
  copy?: string;
  savedAt?: string;
}

export interface SaveStateOptions {
  /** The host's save; it rejects when the text did not save. */
  save: () => Promise<unknown>;
  /** What Copy text copies (the title and body, say). None: no Copy text. */
  copyText?: (() => string) | null;
  /** Its `input` is changed(), its `focusout` (blur) is flush(). */
  watch?: EventTarget | null;
  /** The words' language (default: <html lang>). */
  lang?: string | (() => string);
  words?: SaveStateWords;
  /** Where savestate.css is, for a page that doesn't link it. */
  css?: string | null;
}

export interface SaveScheduler {
  /** The text changed: a save SAVE_AFTER_MS after the last change. */
  changed(): void;
  /** Save now when anything changed; resolves when that save settles. */
  flush(): Promise<void>;
  /** After a failure, try again now (online); else nothing. */
  retry(): Promise<void>;
  state(): SaveStateName;
  /** Every timer stops. */
  destroy(): void;
}

export type SaveState = SaveScheduler;

/** The timing with no DOM: onChange on each change of state. */
export declare function saveScheduler(opts: {
  save: () => Promise<unknown>;
  onChange?: (change: SaveStateChange) => void;
}): SaveScheduler;

/**
 * The save-state line in `el`: <p class="den-savestate" data-state
 * role="status" aria-live="off">, with a polite live region beside it for
 * the error and its recovery. destroy() also removes its listeners and the
 * live region.
 */
export declare function createSaveState(
  el: HTMLElement,
  opts: SaveStateOptions,
): SaveState;
