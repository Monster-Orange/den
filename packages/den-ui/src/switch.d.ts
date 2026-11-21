export interface SwitchModel {
  /** The host's own words: its setting's name. None: nothing is drawn. */
  label: string;
  on?: boolean;
  disabled?: boolean;
  /** The host's own words under the label: the switch's description. */
  help?: string;
  /** The input's id (default: den-sw-N). */
  id?: string;
}

export interface SwitchOptions {
  /** A change by the person (click, Space, Enter). */
  onChange?: (on: boolean) => void;
}

export interface Switch {
  /** Moves it with no call (the host's own change). */
  set(on: boolean): void;
  setDisabled(off: boolean): void;
  on(): boolean;
  destroy(): void;
}

/** <label class="den-switch">: the words, then <input role="switch">. */
export declare function switchHtml(model: SwitchModel): string;

/** The switch's input, or the .den-switch around it. */
export declare function hydrateSwitch(
  el: HTMLElement | null,
  opts?: SwitchOptions,
): Switch;
