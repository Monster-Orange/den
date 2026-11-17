export type DialogKind = "confirm" | "text" | "tell";
export interface DialogOptions {
  title?: string;
  message?: string;
  okLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  /** askText: the field's first text. */
  value?: string;
  /** askText: the field's own name (default: the title). */
  label?: string;
  /** Focus goes back here on close (default: what opened it). */
  opener?: Element | null;
}
export declare const DIALOG_WORDS: Record<string, Record<string, string>>;
export declare function configureDialog(h?: {
  lang?: () => string;
  words?: Record<string, Record<string, string>>;
  report?: (() => string | null) | null;
  /** Where dialog.css is, for a page that doesn't link it. */
  css?: string | null;
}): void;
export declare function dialogWord(key: string): string;
export declare function dialogHtml(
  kind: DialogKind,
  opts: DialogOptions | null | undefined,
  ids: { h: string; m: string },
): string;
export declare function firstFocus(
  kind: DialogKind,
  opts?: DialogOptions | null,
): "field" | "cancel" | "ok";
export declare function answerOf(
  kind: DialogKind,
  ok: boolean,
  text?: string | null,
): boolean | string | null | undefined;
export declare function askConfirm(opts: DialogOptions): Promise<boolean>;
export declare function askText(opts: DialogOptions): Promise<string | null>;
export declare function tell(opts: DialogOptions): Promise<void>;
/** What opened a pop-up: `hint`, the focused element, or the control just pressed. */
export declare function openerOf(hint?: Element | null): HTMLElement | null;
/** Focuses `el` again (no scroll) when it is still on the page and focusable. */
export declare function focusBack(el: Element | null | undefined): boolean;
