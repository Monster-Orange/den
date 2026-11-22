/** Issue 789: a preview of a page or a component, in a sandboxed frame. */

/** The frame's sandbox: scripts run, in an opaque origin. */
export declare const PREVIEW_SANDBOX: "allow-scripts";
/** Hub's mock-page frames. */
export declare const PREVIEW_WIDTHS: readonly [390, 768, 1440];

export type PreviewMode = "light" | "dark";

export interface PreviewHtmlOptions {
  /** The page's body, as HTML. */
  html?: string;
  /** A kit theme by name (themes/<theme>.css), e.g. "sketch"; null: the kit's own look. */
  theme?: string | null;
  mode?: PreviewMode;
  /** Where the kit is served: "/kit/" (Den, the default), "/static/den-ui/" (Hub). */
  kitBase?: string;
  title?: string;
  lang?: string;
}

export interface PreviewOptions extends PreviewHtmlOptions {
  /** The page's own width in px, 240 to 2560 (default 1440). */
  width?: number;
  /** The frame's height in px; the page scrolls inside it (default 800). */
  height?: number;
  /** Scale down to the element's width, never up (default true). */
  fit?: boolean;
}

export interface MountedPreview {
  frame: HTMLIFrameElement;
  setWidth(width: number): void;
  setTheme(theme: string | null, mode?: PreviewMode): void;
  destroy(): void;
}

/** A theme slug, or null; anything else throws. */
export declare function previewTheme(theme: unknown): string | null;
/** The frame's whole document (its srcdoc). */
export declare function previewHtml(opts?: PreviewHtmlOptions): string;
/** Draw a preview into `el`. */
export declare function mountPreview(
  el: HTMLElement,
  opts?: PreviewOptions,
): MountedPreview;
