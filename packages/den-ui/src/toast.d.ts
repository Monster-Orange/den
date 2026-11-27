export declare const PLAIN_MS: number;
export declare const UNDO_MS: number;
export declare const ANNOUNCE_MS: number;
export declare function ensureToastRegions(doc?: Document): void;

export type ToastKind = "status" | "error";

export interface ToastAction {
  label: string;
  onClick?: () => string | void;
}

export interface ToastLink {
  href: string;
  label: string;
}

export interface ShowToastOptions {
  message: string;
  detail?: string;
  kind?: ToastKind;
  onUndo?: () => void;
  actions?: ToastAction[];
  link?: ToastLink;
  ms?: number;
  until?: number;
  lang?: string;
}

export interface ToastHandle {
  close(): void;
}

export interface ToastUndoForm {
  action: string;
  fields?: Readonly<Record<string, string>>;
  method?: string;
}

export interface ToastHtmlOptions {
  message: string;
  detail?: string;
  kind?: ToastKind;
  undo?: { form: ToastUndoForm } | true;
  actions?: { label: string }[];
  link?: ToastLink;
  ms?: number;
  until?: number;
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
