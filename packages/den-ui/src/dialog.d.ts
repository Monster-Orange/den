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
/** One action in a frame: a link (href), else a button. */
export interface DialogAction {
  label: string;
  /**
   * The answer: a submit closes the dialog with it as its returnValue,
   * with no script (method=dialog). Also its data-dk hook.
   */
  value?: string;
  /** A link instead of a button (the second product's way out). */
  href?: string;
  /** "button": does nothing by itself (the page wires it). Default submit. */
  type?: "submit" | "button";
  /** The main action, or one that destroys something. Default plain. */
  kind?: "primary" | "danger";
  className?: string;
  /** Extra attributes (hooks, form, formaction); true is a bare one. */
  attrs?: Record<string, string | number | boolean | null | undefined>;
}
/**
 * Issues 669, 670: the kit's one dialog frame, the same for every
 * product, in a browser or on a server. Text fields (title, subtitle,
 * labels) are escaped; body, extra and foot are HTML the caller escaped.
 */
export interface DialogSpec {
  /** "confirm": a Yes/No question. "panel": a large dialog. */
  kind: "confirm" | "panel";
  /** The dialog's id; its parts' ids follow (<id>-h, -m, -body, -sub). */
  id?: string;
  /** The product's own ids for the heading, message, body, subtitle. */
  ids?: { h?: string; m?: string; body?: string; sub?: string };
  title?: string;
  /** Its name when it has no title. */
  label?: string;
  /** panel: a line beside the heading (null or absent: none). */
  subtitle?: string | null;
  body?: string;
  /** confirm: HTML after the body, before the footer (a field). */
  extra?: string;
  /** panel: HTML after the body, before the footer (a note). */
  foot?: string;
  /** The footer's actions, in order (Report first, then these). */
  actions?: DialogAction[];
  /** panel: actions in the header, before Close. */
  headActions?: DialogAction[];
  /** panel: Close's word (default: the kit's, in the page's language). */
  closeLabel?: string;
  /** panel: extra attributes on Close. */
  closeAttrs?: Record<string, string | number | boolean | null | undefined>;
  /** panel: extra attributes on the body. */
  bodyAttrs?: Record<string, string | number | boolean | null | undefined>;
  /** The product's Report button HTML, first in the footer (a server's). */
  report?: string;
  /** Shown with no script (the open attribute). */
  open?: boolean;
  /**
   * panel: on a phone (640 px or less), a full-screen sheet: no radius,
   * nothing dimmed behind it (issue 791, Peek).
   */
  sheet?: boolean;
  /** Extra classes on the <dialog> (the product's hooks). */
  className?: string;
  /** Extra attributes on the <dialog>. */
  attrs?: Record<string, string | number | boolean | null | undefined>;
  /** Default: alertdialog for confirm, dialog for panel. */
  role?: "dialog" | "alertdialog";
  /** data-dk-kind (default: the kind). */
  dataKind?: string;
}
export interface MountDialogOptions {
  /** Focus goes back here on close (default: what opened it). */
  opener?: Element | null;
  /** A selector to focus first. */
  focus?: string;
  /** When it closes: the action's value; "cancel" for Esc, "close" for Close. */
  onClose?: (value: string, dialog: HTMLDialogElement) => void;
  /** Take it off the page once closed (default: true for HTML). */
  remove?: boolean;
  /** false: mount only; show() later. */
  show?: boolean;
}
export interface MountedDialog {
  dialog: HTMLDialogElement;
  show(opener?: Element | null): MountedDialog;
  close(value?: string): void;
  /** The value it closes with; renewed on each show(). */
  closed: Promise<string>;
}
/** The whole <dialog>, working with no script. Pure. */
export declare function dialogHtml(spec: DialogSpec): string;
/** The 0.9 form: the inside of askConfirm, askText or tell's dialog. */
export declare function dialogHtml(
  kind: DialogKind,
  opts: DialogOptions | null | undefined,
  ids: { h: string; m: string },
): string;
/** askConfirm, askText and tell's options as a frame. */
export declare function askSpec(
  kind: DialogKind,
  opts: DialogOptions | null | undefined,
  id: string,
): DialogSpec;
/** The browser half: modal, focus kept inside, Esc, focus back, Report. */
export declare function mountDialog(
  target: string | HTMLDialogElement,
  opts?: MountDialogOptions,
): MountedDialog;
export declare function firstFocus(
  kind: DialogKind,
  opts?: DialogOptions | null,
): "field" | "cancel" | "ok";
export declare function answerOf(
  kind: DialogKind,
  ok: boolean,
  text?: string | null,
): boolean | string | null | undefined;
/** Issue 864: hear of each kit question just before it shows. */
export declare function onAsk(
  fn: (dialog: HTMLDialogElement) => void,
): () => void;
export declare function askConfirm(opts: DialogOptions): Promise<boolean>;
export declare function askText(opts: DialogOptions): Promise<string | null>;
export declare function tell(opts: DialogOptions): Promise<void>;
/** What opened a pop-up: `hint`, the focused element, or the control just pressed. */
export declare function openerOf(hint?: Element | null): HTMLElement | null;
/** Focuses `el` again (no scroll) when it is still on the page and focusable. */
export declare function focusBack(el: Element | null | undefined): boolean;
/**
 * Focuses `el` now, or, while a kit pop-up is open over it, when that
 * pop-up closes (in place of what opened it). Issue 793.
 */
export declare function focusWhenFree(el: HTMLElement | null | undefined): void;
