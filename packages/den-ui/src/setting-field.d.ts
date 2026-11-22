/** The host's words: its own text, or a key it added with addStrings. */
export type SettingFieldWords =
  | string
  | { key: string; vars?: Record<string, unknown> };
/** The kit's shared button verbs (kit.verb.*). */
export type SettingFieldVerb =
  | "save"
  | "cancel"
  | "delete"
  | "close"
  | "tryAgain";

export interface SettingFieldOptions {
  /** The row's id (safe characters); its parts' ids start with it. */
  id: string;
  /** The input's form name (default: id). */
  name?: string;
  label: SettingFieldWords;
  help?: SettingFieldWords;
  /** A string, or a list (one per line, multi-line). */
  value?: string | string[];
  multiline?: boolean;
  /** A multi-line box's rows (4 by default). */
  rows?: number;
  placeholder?: SettingFieldWords;
  /** Save's words: a shared verb, or the host's own (Save by default). */
  save?: { verb: SettingFieldVerb } | SettingFieldWords;
  /** An error drawn at once (the host's words). */
  error?: SettingFieldWords;
  /** This person can't change it. */
  readOnly?: boolean;
  lang?: string;
}

export interface SettingFieldHydrateOptions {
  /** Save: the value and its lines; resolves to the value as saved, rejects when it did not save. */
  onSave?: (
    value: string,
    lines: string[],
  ) => Promise<string | void> | string | void;
  /** The working pop-up (busy.js `pending` by default). */
  busy?: (button: Element, run: () => Promise<unknown>) => Promise<unknown>;
  lang?: string | (() => string);
}

export interface SettingField {
  /** The box's value. */
  value(): string;
  /** Save now, as a press of Save would. */
  save(): Promise<void>;
  /** Shows the host's words under the box ("" hides them). */
  error(text: string): void;
  destroy(): void;
}

/** The kit's shared button verbs. */
export declare const VERBS: SettingFieldVerb[];
/** A value's lines: trimmed, blank ones dropped. */
export declare function fieldLines(v: string | string[]): string[];
/** The row's markup. */
export declare function settingFieldHtml(o: SettingFieldOptions): string;
/** Wires a drawn row. */
export declare function hydrateSettingField(
  el: Element,
  opts?: SettingFieldHydrateOptions,
): SettingField;
/** Draws the row into el (its contents), then wires it. */
export declare function mountSettingField(
  el: Element,
  opts: SettingFieldOptions & SettingFieldHydrateOptions,
): SettingField;
