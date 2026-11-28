/** DS #7: the look for the job. */
export type ButtonVariant =
  | "secondary"
  | "primary"
  | "danger"
  | "ghost"
  | "link"
  | "icon";
/** 28, 36 (the base) or 44px tall. */
export type ButtonSize = "sm" | "md" | "lg";

export interface ButtonOptions {
  /** The host's words (escaped). An icon button may leave it out with an aria-label. */
  label?: string;
  variant?: ButtonVariant;
  /** With danger: a dialog's filled confirm. */
  primary?: boolean;
  size?: ButtonSize;
  /** A link drawn as a button. */
  href?: string;
  type?: "button" | "submit" | "reset";
  /** A kit icon's name (icons.js), drawn before the label; any other is dropped. */
  icon?: string;
  /** A disabled button; a link with no href and aria-disabled. */
  disabled?: boolean;
  /** Disabled with a reason: stays focusable, the reason in title and aria-describedby. */
  disabledWhy?: string;
  pressed?: boolean;
  /** A menu or disclosure trigger: aria-expanded and a turning ▾. */
  expanded?: boolean;
  /** "summary" draws a <summary> (a disclosure's trigger). */
  as?: "summary";
  id?: string;
  /** data- and aria- attributes only; any other is dropped. */
  attrs?: Record<string, string | number | boolean | null | undefined>;
}

export declare function buttonClass(
  variant?: ButtonVariant,
  size?: ButtonSize,
  primary?: boolean,
): string;
/** A `.den-btn`, or "" for an icon button with no name. */
export declare function buttonHtml(o: ButtonOptions): string;
/** Holds a button busy (aria-busy, aria-disabled; dots unless instant); returns its release. */
export declare function holdButton(
  el: HTMLElement | null,
  opts?: { instant?: boolean },
): () => void;
/** Sets title on each button whose label is cut off, and takes it off when it fits again. */
export declare function hydrateButtons(root?: ParentNode): void;
