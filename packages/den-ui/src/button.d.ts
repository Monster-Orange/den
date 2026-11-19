/** The general button's look: secondary (the base) or the accent fill. */
export type ButtonVariant = "secondary" | "primary";
/** The general button's size: md (the base) or small. */
export type ButtonSize = "md" | "sm";

export interface ButtonOptions {
  /** The host's words (escaped). */
  label: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** A link drawn as a button. */
  href?: string;
  type?: "button" | "submit" | "reset";
  /** A disabled button; a link with no href and aria-disabled. */
  disabled?: boolean;
  id?: string;
  /** data- and aria- attributes only; any other is dropped. */
  attrs?: Record<string, string | number | boolean | null | undefined>;
}

/** The class list for a variant and size: "den-btn primary sm". */
export declare function buttonClass(
  variant?: ButtonVariant,
  size?: ButtonSize,
): string;
/** A `.den-btn` (button.css): a button, or a link drawn as one. */
export declare function buttonHtml(o: ButtonOptions): string;
