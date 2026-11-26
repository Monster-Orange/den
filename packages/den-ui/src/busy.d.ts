export declare const OPEN_MS: number;
export declare const MIN_MS: number;
export declare const STILL_MS: number;
export declare const NO_ANSWER_MS: number;
export declare const SUCCESS_CLOSE_MS: number;
export declare const POLL_MS: number;
export declare const POLL_MAX_MS: number;
export declare const ASK_MS: number;

export type Words = Record<string, Record<string, string>>;
/** Check again's answer: how a request id ended. */
export interface RequestState {
  state: "done" | "failed" | "running" | "unknown";
  result?: unknown;
  error?: { code?: number; message?: string };
}
export interface BusyHooks {
  lang?: () => string;
  words?: Words;
  idHeader?: string;
  statusUrl?: (id: string) => string;
  /** Check again through the product's adapter (statusUrl is then unused). */
  request?: (id: string) => Promise<RequestState | null>;
  report?:
    | ((info: { title: string; details: string; requestId: string }) => void)
    | null;
  toast?: ((text: string) => void) | null;
  open?: (url: string) => void;
  logUrl?: string | null;
  reconnect?: {
    url: string;
    back: (now: unknown, before: unknown) => boolean;
    waitMs?: (before: unknown) => number;
    version?: (now: unknown) => string;
    done?: (now: unknown) => void;
  } | null;
}
export interface BusyActionDef {
  who?: string;
  autoClose?: boolean;
  inline?: boolean;
  mode?: "reconnect";
  /** It names its steps (issue 1054): the Working pop-up after dotsMs. */
  steps?: boolean;
  words: Words;
}
export interface BusyOptions<T = unknown> {
  button?: HTMLElement | null;
  /** This call names its steps (issue 1054), as BusyActionDef.steps. */
  steps?: boolean;
  vars?: Record<string, string | number>;
  success?: (data: T) => string;
  onDone?: (data: T) => void;
  onFail?: (err: unknown) => void;
  toastFast?: boolean;
  quietFail?: boolean;
  inlineError?: boolean;
  skipDone?: (data: T) => boolean;
  extra?: (data: T) => Node | null | undefined;
  before?: unknown;
  /**
   * A failure trying again won't fix: its link (the primary) in place of
   * Try again; or, from the failure, null for Try again as before.
   */
  next?: NextStep | ((err: unknown) => NextStep | null | undefined) | null;
}
export interface NextStep {
  label: string;
  /** None: the words in place of Try again, and Close is the primary. */
  href?: string;
}
/** run's second argument: a progress line under the working title. */
export type Progress = (text: string) => void;
export declare function configureBusy(h?: BusyHooks): void;
export declare function registerActions(
  map: Record<string, BusyActionDef>,
): void;
export declare function busyActionOf(name: string): BusyActionDef | null;
/** The first message with words in an error or its answer, else "". */
export declare function messageOf(err: unknown): string;
export declare function busyAction<T = unknown>(
  name: string,
  run: (headers: Record<string, string>, progress: Progress) => Promise<T> | T,
  opts?: BusyOptions<T>,
): Promise<T | null>;

/** Issue 699: the working pop-up's wait once a button shows dots (3000). */
export declare const DOTS_MS: number;
export interface BusyHooks {
  /**
   * Issue 699: how long a held button shows dots before the working
   * pop-up opens (ms; default DOTS_MS, 3000).
   */
  dotsMs?: number;
}
export interface BusyOptions<T = unknown> {
  /** Issue 699: false holds the button without dots (and OPEN_MS). */
  dots?: boolean;
}
export interface PendingOptions<T = unknown> extends BusyOptions<T> {
  /** A registered action's name; default the kit's own (Sending…). */
  action?: string;
  /** Who the kit's own action waits for; default "the server". */
  who?: string;
}
/**
 * Issue 699: a fetch-driven button. Dots at once; the answer (a Response
 * that isn't ok, or no answer, is the failure pop-up with Try again); null
 * after Close, or at once for a button already held.
 */
export declare function pending<T = unknown>(
  button: HTMLElement,
  run: (headers: Record<string, string>, progress: Progress) => Promise<T> | T,
  opts?: PendingOptions<T>,
): Promise<T | null>;
/**
 * Issue 699: one submit listener for plain POST forms; the submitter
 * shows dots until the next page. Returns stop().
 */
export declare function watchForms(root?: Document | HTMLElement): () => void;
/**
 * Issue 698: the dots alone, with no pop-up, for a wait that says its own
 * words. holdDots(button, false) gives the label back.
 */
export declare function holdDots(
  button: HTMLElement | null | undefined,
  on?: boolean,
): void;
/** How many buttons the kit holds with dots now (a number, never them). */
export declare function heldCount(): number;
/** Issue 1054: a row that waits: the dots at its end, aria-busy. */
export declare function holdRow(
  row: HTMLElement | null | undefined,
  on?: boolean,
): void;
/** Issue 699: each data-instant in the markup with no reason. */
export declare function instantProblems(html: string): string[];
