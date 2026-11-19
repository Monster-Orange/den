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
