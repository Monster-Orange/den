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

/** The bare switch (issue 680), for a row that draws its own label. */
export interface SwitchInputModel {
  /** The input's id (default: den-sw-N): a row's <label for> names it. */
  id?: string;
  on?: boolean;
  disabled?: boolean;
  /** The id of the element that names it, when no <label for> does. */
  labelledBy?: string;
  /** The id of its description. */
  describedBy?: string;
  /** More attributes (escaped), e.g. a host's data-*. */
  attrs?: Record<string, string>;
}

/** <input type="checkbox" role="switch" class="den-switch-input">. */
export declare function switchInputHtml(model: SwitchInputModel): string;

/** The switch's input, or the .den-switch around it. */
export declare function hydrateSwitch(
  el: HTMLElement | null,
  opts?: SwitchOptions,
): Switch;
