export declare function typesText(el: Element | null | undefined): boolean;
export declare const KEYBOARD_MIN: number;
export declare function keyboardIsUp(s: {
  coarse: boolean;
  typing: boolean;
  innerHeight: number;
  visibleHeight: number;
  /** Default KEYBOARD_MIN. */
  min?: number;
}): boolean;
export declare function dismisses(target: Element | null | undefined): boolean;
export declare function initKeyboardUp(
  win?: Window,
  opts?: { min?: number },
): () => void;
