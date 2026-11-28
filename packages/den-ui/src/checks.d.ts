export interface CheckItem {
  value: string;
  label: string;
  help?: string;
}

export interface ChecksModel {
  id?: string;
  legend: string;
  items: CheckItem[];
  checked?: string[];
  disabled?: boolean;
  note?: string;
  intro?: string | string[];
  noteAction?: { label: string; onClick?: () => void };
}

export interface ChecksOptions extends ChecksModel {
  onSave?: (values: string[]) => Promise<unknown> | unknown;
  empty?: string;
  lang?: string | (() => string);
}

export interface Checks {
  values(): string[];
  set(values: string[]): void;
  setDisabled(off: boolean, note?: string): void;
  destroy(): void;
}
export declare function checksHtml(model: ChecksModel): string;
export declare function mountChecks(
  el: HTMLElement,
  opts: ChecksOptions,
): Checks;
