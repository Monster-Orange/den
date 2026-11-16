export declare const OPEN_MS: number;
export declare const MIN_MS: number;
export declare const STILL_MS: number;
export declare const NO_ANSWER_MS: number;
export declare const SUCCESS_CLOSE_MS: number;
export declare const POLL_MS: number;
export declare const POLL_MAX_MS: number;

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
  words: Words;
}
export interface BusyOptions<T = unknown> {
  button?: HTMLElement | null;
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
