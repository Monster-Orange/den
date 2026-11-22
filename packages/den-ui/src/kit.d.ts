import type { ChangelogEntry, WhatsNewOptions } from "./whatsnew.js";
import type { ReportAdapter, ReportOptions } from "./report.js";
import type {
  RequestState,
  BusyOptions,
  Progress,
  configureBusy,
  pending,
  watchForms,
  holdDots,
} from "./busy.js";
import type {
  AccountHydrateOptions,
  AppearanceHandle,
  AppearanceHydrateOptions,
  setWaiting,
  hydrateAppearance,
  BellHandle,
  BellHydrateOptions,
  HydrateOptions,
  ScopeHandle,
  ScopeHydrateOptions,
  SearchHandle,
  SearchHydrateOptions,
  Shell,
  hydrateAccount,
  attachMenuFilter,
  hydrateBell,
  wireRowOpens,
  hydrateScope,
  hydrateSearch,
  PageMenuHydrateOptions,
} from "./shell-client.js";
import type {
  ShellModel,
  shellHtml,
  topBarHtml,
  markHtml,
  railHtml,
  navItemHtml,
  versionChipHtml,
  reportButtonHtml,
  reportPrefillOf,
  scopeHtml,
  scopeCrumbHtml,
  searchHtml,
  bellButtonHtml,
  bellPanelHtml,
  accountHtml,
  accountWho,
  accountMenuHtml,
  settingsHtml,
  appearanceButtonHtml,
  appearanceMenuHtml,
  waitingHtml,
  menuRowHtml,
  pageMenuButtonHtml,
  pageMenuHtml,
  icon,
  esc,
} from "./shell-html.js";
import type { buttonHtml } from "./button.js";
import type {
  SettingRow,
  SettingRowHydrateOptions,
  SettingRowOptions,
  settingRowHtml,
} from "./setting-row.js";
import type { syncPinToggles } from "./shell-client.js";
import type { UpdatePill } from "./update-pill.js";
import type { SaveState, SaveStateOptions } from "./savestate.js";
import type { FilterBar, FilterBarOptions } from "./filter-bar.js";
import type { BulkBar, BulkBarOptions } from "./bulk-bar.js";

/** Every call to the product goes through it; the kit names no URL. */
export interface Adapter extends ReportAdapter {
  changelog?: () => Promise<ChangelogEntry[]>;
  applyUpdate?: () => Promise<unknown>;
  request?: (id: string) => Promise<RequestState | null>;
}
export interface KitConfig {
  lang?: string | (() => string);
  product?: { name: string };
  adapter?: Adapter;
  reportOff?: boolean;
  whatsNew?: Omit<WhatsNewOptions, "lang" | "changelog">;
  report?: Omit<ReportOptions, "lang" | "adapter">;
}
export interface UpdateSetOptions {
  version?: string;
  message?: string;
  reloadLabel?: string;
  dismissLabel?: string;
  cancelLabel?: string;
  region?: string;
  askFirst?: () => { message: string } | null;
  onReload?: () => void;
  onDismiss?: () => void;
}
export interface KitHydrateOptions extends HydrateOptions {
  /** false: the version chip does not open What's new. */
  versionChip?: boolean;
  /** false: no [data-den-report] clicks or ⌘⇧F. */
  report?: boolean;
  /** 0.7.0: the scope crumbs' menus (false: not wired). */
  scope?: ScopeHydrateOptions | false;
  /** 0.7.0: the search field (false: not wired). */
  search?: SearchHydrateOptions | false;
  /** 0.7.0: the bell and its panel (false: not wired). */
  bell?: Omit<BellHydrateOptions, "lang"> | false;
  /** 0.7.0: the account entry as an action (false: not wired). */
  account?: Omit<AccountHydrateOptions, "lang"> | false;
  /** 0.7.0: ◐ ▾ and its menu (wired when given). */
  appearance?: Omit<AppearanceHydrateOptions, "lang">;
}
/** The shell hydrate returns: the 0.7.0 pieces it found and wired. */
export interface KitShell extends Shell {
  scope?: ScopeHandle;
  search?: SearchHandle;
  bell?: BellHandle;
  appearance?: AppearanceHandle;
  /** The account entry's menu, when it has one. */
  account?: AppearanceHandle;
}
export declare function configure(o?: KitConfig): void;
export declare function t(
  key: string,
  vars?: Record<string, string | number>,
): string;
export declare function strings(
  lang: string,
  table: Record<string, string>,
): void;
export declare const version: {
  label(
    running: string | null | undefined,
    changelog: { version: string }[],
  ): string | null;
  set(label: string): void;
  unread(on: boolean): void;
  /** 0.7.0: the update-waiting pill after the chip; null hides it. */
  waiting: typeof setWaiting;
};
export declare const whatsNew: {
  open(): void;
  close(): void;
  load(): Promise<ChangelogEntry[]>;
  setEntries(list: ChangelogEntry[]): void;
};
export declare const update: {
  set(o?: UpdateSetOptions): UpdatePill;
  hide(): void;
};
export declare const report: {
  open(opts?: {
    prefill?: { kind?: string; title?: string; description?: string };
    /** Focus goes back here on close (default: what opened it). */
    opener?: Element | null;
    draft?: string;
  }): Promise<unknown>;
  button(o?: {
    inFoot?: boolean;
    inTop?: boolean;
    label?: string;
    prefill?: { kind?: string; title?: string; description?: string };
  }): string;
};
export declare const busy: {
  run<T = unknown>(
    action: string,
    run: (
      headers: Record<string, string>,
      progress: Progress,
    ) => Promise<T> | T,
    opts?: BusyOptions<T>,
  ): Promise<T | null>;
  /** Issue 699: a fetch-driven button shows dots until the answer. */
  pending: typeof pending;
  /** Issue 699: plain POST forms' submitters show dots. Returns stop(). */
  watchForms: typeof watchForms;
  /** Issue 698: the dots alone (no pop-up); (button, false) lets go. */
  holdDots: typeof holdDots;
  configure: typeof configureBusy;
};
/** An autosaving editor's save-state line, in the kit's language. */
export declare function saveState(
  el: HTMLElement,
  opts: SaveStateOptions,
): SaveState;
/** A list's filter bar, in the kit's language. */
export declare function filterBar(
  el: HTMLElement,
  opts: FilterBarOptions,
): FilterBar;
/** A list's bulk bar, in the kit's language. */
export declare function bulkBar(el: HTMLElement, opts: BulkBarOptions): BulkBar;
/** The page action menu on a drawn More ▾ button, in the kit's language. */
export declare function pageMenu(
  btn: HTMLElement,
  opts: PageMenuHydrateOptions,
): AppearanceHandle;
/**
 * The settings on/off row, in the kit's language: with a row's data (a
 * label), drawn into el first; else the row el holds is wired.
 */
export declare function settingRow(
  el: HTMLElement,
  opts: SettingRowHydrateOptions & Partial<SettingRowOptions>,
): SettingRow;
export declare function hydrate(
  root: ParentNode,
  opts?: KitHydrateOptions,
): KitShell;
export declare function mount(
  root: Element,
  model?: ShellModel & { hydrate?: KitHydrateOptions },
): KitShell;

export interface DenUIKit {
  configure: typeof configure;
  hydrate: typeof hydrate;
  mount: typeof mount;
  shellHtml: typeof shellHtml;
  topBarHtml: typeof topBarHtml;
  markHtml: typeof markHtml;
  railHtml: typeof railHtml;
  navItemHtml: typeof navItemHtml;
  versionChipHtml: typeof versionChipHtml;
  reportButtonHtml: typeof reportButtonHtml;
  reportPrefillOf: typeof reportPrefillOf;
  scopeHtml: typeof scopeHtml;
  scopeCrumbHtml: typeof scopeCrumbHtml;
  searchHtml: typeof searchHtml;
  bellButtonHtml: typeof bellButtonHtml;
  bellPanelHtml: typeof bellPanelHtml;
  accountHtml: typeof accountHtml;
  accountWho: typeof accountWho;
  accountMenuHtml: typeof accountMenuHtml;
  settingsHtml: typeof settingsHtml;
  appearanceButtonHtml: typeof appearanceButtonHtml;
  appearanceMenuHtml: typeof appearanceMenuHtml;
  waitingHtml: typeof waitingHtml;
  hydrateAppearance: typeof hydrateAppearance;
  setWaiting: typeof setWaiting;
  hydrateScope: typeof hydrateScope;
  hydrateSearch: typeof hydrateSearch;
  hydrateBell: typeof hydrateBell;
  wireRowOpens: typeof wireRowOpens;
  hydrateAccount: typeof hydrateAccount;
  attachMenuFilter: typeof attachMenuFilter;
  syncPinToggles: typeof syncPinToggles;
  icon: typeof icon;
  esc: typeof esc;
  t: typeof t;
  strings: typeof strings;
  version: typeof version;
  whatsNew: typeof whatsNew;
  update: typeof update;
  report: typeof report;
  busy: typeof busy;
  saveState: typeof saveState;
  filterBar: typeof filterBar;
  bulkBar: typeof bulkBar;
  buttonHtml: typeof buttonHtml;
  menuRowHtml: typeof menuRowHtml;
  pageMenuButtonHtml: typeof pageMenuButtonHtml;
  pageMenuHtml: typeof pageMenuHtml;
  pageMenu: typeof pageMenu;
  settingRowHtml: typeof settingRowHtml;
  settingRow: typeof settingRow;
}
declare const DenUI: DenUIKit;
export default DenUI;

declare global {
  interface Window {
    DenUI?: DenUIKit;
  }
}
