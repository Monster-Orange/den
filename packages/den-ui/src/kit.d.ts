import type { ChangelogEntry, WhatsNewOptions } from "./whatsnew.js";
import type { ReportAdapter, ReportOptions } from "./report.js";
import type {
  RequestState,
  BusyOptions,
  Progress,
  configureBusy,
} from "./busy.js";
import type { HydrateOptions, Shell } from "./shell-client.js";
import type {
  ShellModel,
  shellHtml,
  topBarHtml,
  railHtml,
  navItemHtml,
  versionChipHtml,
  reportButtonHtml,
  icon,
  esc,
} from "./shell-html.js";
import type { syncPinToggles } from "./shell-client.js";
import type { UpdatePill } from "./update-pill.js";

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
    draft?: string;
  }): Promise<unknown>;
  button(o?: { inFoot?: boolean; inTop?: boolean }): string;
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
  configure: typeof configureBusy;
};
export declare function hydrate(
  root: ParentNode,
  opts?: KitHydrateOptions,
): Shell;
export declare function mount(
  root: Element,
  model?: ShellModel & { hydrate?: KitHydrateOptions },
): Shell;

export interface DenUIKit {
  configure: typeof configure;
  hydrate: typeof hydrate;
  mount: typeof mount;
  shellHtml: typeof shellHtml;
  topBarHtml: typeof topBarHtml;
  railHtml: typeof railHtml;
  navItemHtml: typeof navItemHtml;
  versionChipHtml: typeof versionChipHtml;
  reportButtonHtml: typeof reportButtonHtml;
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
}
declare const DenUI: DenUIKit;
export default DenUI;

declare global {
  interface Window {
    DenUI?: DenUIKit;
  }
}
