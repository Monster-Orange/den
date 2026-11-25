/** den-ui: the toast (issue 559). See toast.js. */
export declare const PLAIN_MS: number;
export declare const UNDO_MS: number;

export type ToastKind = "status" | "error";

/** One of the host's own buttons: its label, and what it does. */
export interface ToastAction {
  label: string;
  /** May return the button's new words ("Copied", say); the toast stays. */
  onClick?: () => string | void;
}

export interface ToastLink {
  href: string;
  label: string;
}

export interface ShowToastOptions {
  /** The host's words, in the page's language. */
  message: string;
  /** A second, smaller line (a request id, say). */
  detail?: string;
  /** "status" (default), or "error": role="alert", Close, no timer. */
  kind?: ToastKind;
  /** Undo shows; it runs once, then "Undone." shows for a plain time. */
  onUndo?: () => void;
  actions?: ToastAction[];
  link?: ToastLink;
  /** How long it shows (default: 3 s, or 8 s with Undo). */
  ms?: number;
  lang?: string;
}

export interface ToastHandle {
  close(): void;
}

export interface ToastUndoForm {
  action: string;
  fields?: Readonly<Record<string, string>>;
  /** "post" only (the default); anything else throws. */
  method?: string;
}

export interface ToastHtmlOptions {
  message: string;
  detail?: string;
  kind?: ToastKind;
  /** A POST form that works with no script, or true: a button the client wires. */
  undo?: { form: ToastUndoForm } | true;
  actions?: { label: string }[];
  link?: ToastLink;
  ms?: number;
  lang?: string;
}

export declare function showToast(
  o: ShowToastOptions,
  doc?: Document,
): ToastHandle;
export declare function toastHtml(o: ToastHtmlOptions): string;
export declare function hydrateToast(
  doc?: Document,
  o?: Partial<ShowToastOptions>,
): ToastHandle | null;

export interface ToastClock {
  start(): void;
  hold(why: "hover" | "focus" | "hidden"): void;
  release(why: "hover" | "focus" | "hidden"): void;
  undone(): void;
  stop(): void;
  held(): string[];
  running(): boolean;
}
export declare function toastClock(o?: {
  kind?: ToastKind;
  ms?: number;
  undo?: boolean;
  onExpire?: () => void;
  set?: (f: () => void, ms: number) => unknown;
  clear?: (t: unknown) => void;
}): ToastClock;
