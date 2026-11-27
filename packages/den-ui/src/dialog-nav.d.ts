export interface DialogNavPane {
  id: string;
  title: string;
  desc?: string;
  html?: string;
  lazy?: boolean;
  readOnly?: string;
}
export interface DialogNavGroup {
  label?: string;
  panes: DialogNavPane[];
}
export interface DialogNavWords {
  close: string;
  searchAccount: string;
  searchSettings: string;
  noMatch: string;
  back: string;
  toSettings: string;
  toAccount: string;
  discard: string;
  discardYes: string;
  discardNo: string;
}
export interface DialogNavSpec {
  id?: string;
  kind?: "account" | "settings";
  param?: string;
  title: string;
  groups: DialogNavGroup[];
  open?: string;
  href?: string;
  cross?: { href: string; label?: string };
  lang?: string;
  words?: Partial<DialogNavWords>;
  shown?: boolean;
}
export interface DialogNavOptions {
  lang?: string;
  words?: Partial<DialogNavWords>;
  url?: boolean;
  load?: (pane: string, body: HTMLElement) => unknown;
  onCross?: (href: string) => void;
  onClose?: () => void;
}
export interface DialogNav {
  open(
    pane?: string | null,
    at?: string | null,
    from?: Element | null,
  ): DialogNav;
  show(
    pane: string,
    at?: string | null,
    how?: "push" | "replace" | "none",
  ): void;
  close(): Promise<boolean>;
  element: HTMLDialogElement;
}
export declare const DIALOG_NAV_WORDS: Record<string, DialogNavWords>;
export declare function dialogNavHtml(spec: DialogNavSpec): string;
export declare function hydrateDialogNav(
  dialog: HTMLDialogElement | null,
  opts?: DialogNavOptions,
): DialogNav | undefined;
