/** A Playwright Page, or anything that evaluates a function in a page. */
export interface NavPage {
  evaluate<R, A>(fn: (arg: A) => R | Promise<R>, arg: A): Promise<R>;
}
/** Where an element sits: the top bar, the rail, or the rail's foot. */
export type NavSlot = "top" | "rail" | "foot";
export interface NavBox {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface NavElement {
  /** "#id", '[data-nav="x"]', or the parent's key " > " tag.class[n]. */
  key: string;
  parent: string | null;
  slot: NavSlot;
  role: string;
  tag: string;
  /** aria-label, else aria-labelledby, else alt, else its text, else title. */
  name: string;
  classes: string[];
  box: NavBox;
  /** Computed styles, by property name (STYLE_PROPS). */
  style: Record<string, string>;
  /**
   * Host content: the nearest element (this one or an ancestor) with a
   * data-nav-role, by role and key. Absent on the kit's own chrome.
   */
  host?: {
    role: string;
    key: string;
    /** On the role's own element: its contents' width with padding and border. */
    fit?: number;
  };
  /** Its accessible name is the host's words (data-nav-name="host"). */
  hostName?: boolean;
}
export interface NavTheme {
  id: string;
  version: string;
}
export interface NavEnv {
  userAgent: string;
  /** Each face ("<weight> <size> <family>") → its fixed line's width, px. */
  faces: Record<string, number>;
  /** Where the browser ran (collectNav's `image`), if given. */
  image?: string;
  /** The theme the page drew in (collectNav's `theme`), if given. */
  theme?: NavTheme;
}
export interface NavSnapshot {
  version: number;
  viewport: { w: number; h: number };
  /** The browser build: boxes compare only between equal fingerprints. */
  env: NavEnv;
  elements: NavElement[];
  /** Each colour and font-family seen → the :root --tokens that compute to it. */
  tokens: Record<string, string[]>;
}
export interface NavCompareOptions {
  /** Keys ("#den-status") or one class (".den-scope"): left out, with all under them. */
  hostSlots?: string[];
  /**
   * Tokens ("--accent", "--sans") whose colour or font-family may differ.
   * Default empty; never for a parity run (both products run in NAV_THEME).
   */
  themeTokens?: string[];
  /** How far a box edge may move, in px (default 2). */
  tolerance?: number;
}
export interface NavDiff {
  key: string;
  slot: NavSlot | "";
  /** "env" (another browser build), "theme" (another theme), "element", "order", "slot", "role", "tag", "name", "classes", "box.<edge>", "style.<prop>", "version". */
  property: string;
  reference: string | number;
  actual: string | number;
}
export declare const STYLE_PROPS: string[];
export declare const COLOR_PROPS: string[];
/** Colours and font-family: what a theme token may stand for. */
export declare const TOKEN_PROPS: string[];
export declare const NAV_INVENTORY_VERSION: number;
/** The pinned Playwright image (version and digest) the nav is measured in. */
export declare const NAV_BROWSER_IMAGE: string;
export declare const FINGERPRINT_TEXT: string;
/** The theme the reference was taken in ("den" 2.0.1): every parity run uses it. */
export declare const NAV_THEME: NavTheme;
/**
 * issue 303: classes of the top bar's pinned elements (the search, Report,
 * the bell, the version chip, ◐ ▾): compared at the reference's x and
 * width, with no host-content allowance.
 */
export declare const PINNED_CLASSES: readonly string[];
export declare function collectNav(
  page: NavPage,
  opts?: { image?: string; theme?: NavTheme },
): Promise<NavSnapshot>;
/** The browser build's fingerprint: user agent and the faces' widths. */
export declare function fingerprint(snap: NavSnapshot): string;
/** A font family or face key as one line: whitespace runs one space, trimmed. */
export declare function navFamily(s: string): string;
export declare function compareNav(
  actual: NavSnapshot,
  reference: NavSnapshot,
  opts?: NavCompareOptions,
): NavDiff[];
export declare function formatNavDiffs(diffs: NavDiff[]): string;
/** The pin stylesheet: the system faces a nav names, as the kit's own files. */
export declare const PIN_FONTS_CSS: string;
/**
 * What pinNavFonts needs of a Playwright BrowserContext. Its results are
 * not used: Playwright's resolve to a Disposable (1.61), others to nothing.
 */
export interface NavFontContext {
  route(
    url: string,
    handler: (route: {
      request(): { url(): string };
      fulfill(o: {
        status?: number;
        contentType?: string;
        body?: string | Buffer;
      }): Promise<unknown>;
    }) => unknown,
  ): Promise<unknown>;
  addInitScript(script: () => void): Promise<unknown>;
}
/**
 * Pins a context's fonts the way the reference was taken: the pin
 * stylesheet first on every page, /__pin-fonts/* served from the kit's
 * own font files (src/fonts, or opts.fontsDir). Call it before opening a
 * page.
 */
export declare function pinNavFonts(
  context: NavFontContext,
  opts?: { fontsDir?: string },
): Promise<void>;
