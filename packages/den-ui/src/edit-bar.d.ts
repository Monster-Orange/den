export interface EditBarWords {
  unsaved: string;
  notePh: string;
  cancel: string;
  saveAs: string;
  errEmpty: string;
  leaveTitle: string;
  leaveBody: string;
  keep: string;
  leave: string;
  notSaved: string;
  still: string;
}
export interface EditBarSpec {
  save?: string;
  version?: number | string;
  cancel: { href: string; label?: string } | { form: string; label?: string };
  note?: { name: string; value?: string; max?: number; id?: string };
  line?: string;
  form?: string;
  lang?: string;
  words?: Partial<EditBarWords>;
}
export interface EditBarOptions {
  lang?: string;
  words?: Partial<EditBarWords>;
  leaveBody?: string;
  onSave?: (
    data: FormData,
    ctx: { form: HTMLFormElement; bar: HTMLElement },
  ) =>
    | Promise<boolean | { error: string } | void>
    | boolean
    | { error: string }
    | void;
  onLeave?: () => void;
}
export interface EditBar {
  dirty(): boolean;
  setSave(text: string): void;
  fail(text?: string): void;
  destroy(): void;
}
export declare const EDIT_BAR_WORDS: Record<string, EditBarWords>;
export declare function editBarHtml(spec: EditBarSpec): string;
export declare function wireEditBar(
  bar: HTMLElement | null,
  opts?: EditBarOptions,
): EditBar;
