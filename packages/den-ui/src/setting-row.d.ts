import type { HostWords } from "./strings.js";

/** The row's save state. */
export type SettingRowState = "idle" | "saving" | "saved" | "error";

/** The settings on/off row's data. */
export interface SettingRowOptions {
  /** The row's id (safe characters); its parts' ids start with it. */
  id: string;
  /** The checkbox's form name (default: id). */
  name?: string;
  /** The host's words. */
  label: string;
  /** A help line under the label (the host's words); "" for none. */
  help?: string;
  checked?: boolean;
  /** Who can change it, the host's words; [] is nobody. */
  who?: string[];
  /** The last change: who (the host's words) and an ISO time; null: none yet. */
  last?: { by: string; at: string } | null;
  /** This person can't change it: the box and Save are disabled. */
  readOnly?: boolean;
  state?: SettingRowState;
  /** A form that posts with no script (csrf in a hidden field named `field`). */
  form?: {
    action: string;
    method?: string;
    csrf?: string;
    field?: string;
  } | null;
  lang?: string;
  /** The time's clock and zone (default: now, the person's zone). */
  now?: string | Date;
  zone?: string;
}

export interface SettingRowHydrateOptions {
  /** Save: the box's state; it rejects when it did not save. */
  onSave?: (checked: boolean) => Promise<unknown> | unknown;
  lang?: string | (() => string);
}

export interface SettingRow {
  /** Draws a state the host decides. */
  set(state: SettingRowState): void;
  /** The box's state. */
  checked(): boolean;
  /** Save now, as a press of Save would. */
  save(): Promise<void> | undefined;
  destroy(): void;
}

/** The state line's words for a state ("" for idle). */
export declare function settingStateText(
  state: SettingRowState,
  lang?: string,
): string;
/** The line under the row: who can change it · its last change (HTML). */
export declare function settingMetaHtml(o: {
  who?: string[];
  last?: { by: string; at: string } | null;
  lang?: string;
  now?: string | Date;
  zone?: string;
}): string;
/** The row's markup. */
export declare function settingRowHtml(o: SettingRowOptions): string;
/** Wires a drawn row. */
export declare function hydrateSettingRow(
  el: Element,
  opts?: SettingRowHydrateOptions,
): SettingRow;
/** Draws the row into el (its contents), then wires it. */
export declare function mountSettingRow(
  el: Element,
  opts: SettingRowOptions & SettingRowHydrateOptions,
): SettingRow;

/** The field row's data (issue 584): a text field, its help and Save. */
export interface SettingFieldOptions {
  /** The row's id (safe characters); its parts' ids start with it. */
  id: string;
  /** The field's form name (default: id). */
  name?: string;
  /** The host's words, or { key, vars } in the kit's tables. */
  label: HostWords;
  /** A help line (the host's words); "" or none for none. */
  help?: HostWords | null;
  /** The saved value; a list is one item per line. */
  value?: string;
  placeholder?: HostWords | null;
  /** A textarea of `rows` lines (default 4); else a single-line input. */
  multiline?: boolean;
  rows?: number;
  /** The host's words under the input; null: none. */
  error?: HostWords | null;
  /** Save's words: the kit's shared verb by default. */
  saveLabel?: HostWords | null;
  /** This person can't change it: the field is read-only, Save disabled. */
  readOnly?: boolean;
  state?: SettingRowState;
  form?: SettingRowOptions["form"];
  /** Who can change it and its last change: the line only when given. */
  who?: string[];
  last?: { by: string; at: string } | null;
  lang?: string;
  now?: string | Date;
  zone?: string;
}

export interface SettingFieldHydrateOptions {
  /**
   * Save: the value; it resolves with the saved value (text) or nothing,
   * and rejects when it did not save (fieldError: the words to show).
   * headers: the working pop-up's request id, with `action`.
   */
  onSave?: (
    value: string,
    headers?: Record<string, string>,
  ) => Promise<unknown> | unknown;
  /** A working pop-up action the host registered (busy.js). */
  action?: string;
  lang?: string | (() => string);
}

/** A rejection of onSave may carry the words for the error line. */
export interface SettingFieldError extends Error {
  fieldError?: HostWords;
}

export interface SettingField {
  /** Draws a state the host decides ("error": the kit's words). */
  set(state: SettingRowState): void;
  /** The error line: the host's words; null clears it. */
  setError(words: HostWords | null): void;
  /** The field's value now. */
  value(): string;
  /** Save now, as a press of Save would. */
  save(): Promise<void> | undefined;
  destroy(): void;
}

/** The field row's markup. */
export declare function settingFieldHtml(o: SettingFieldOptions): string;
/** Wires a drawn field row. */
export declare function hydrateSettingField(
  el: Element,
  opts?: SettingFieldHydrateOptions,
): SettingField;
/** Draws the field row into el (its contents), then wires it. */
export declare function mountSettingField(
  el: Element,
  opts: SettingFieldOptions & SettingFieldHydrateOptions,
): SettingField;
