export interface ChangelogItem {
  text: string;
  items?: ChangelogItem[];
}
export interface ChangelogEntry {
  version: string;
  date?: string;
  sections?: Record<string, ChangelogItem[]>;
}
export interface WhatsNewOptions {
  lang?: string | (() => string);
  /** The adapter's changelog(): newest first. */
  changelog?: (() => Promise<ChangelogEntry[]>) | null;
  /** The Report button's HTML for the footer ("" for none). */
  reportButton?: () => string;
  /** After a close, with the newest version shown. */
  onClose?: (latest: string | null) => void;
}
export declare function configureWhatsNew(o?: WhatsNewOptions): void;
export declare function changelogView(
  list: ChangelogEntry[],
  all: boolean,
): {
  shown: ChangelogEntry[];
  toggle: { label: string; expanded: boolean } | null;
};
export declare function setEntries(list: ChangelogEntry[]): void;
export declare function getEntries(): ChangelogEntry[];
export declare function loadWhatsNew(): Promise<ChangelogEntry[]>;
export declare function ensureWhatsNew(): void;
export declare function renderBody(): void;
export declare function copyText(text: string): Promise<void>;
export declare function buildRichHtml(entry: ChangelogEntry): string;
export declare function buildMarkdown(entry: ChangelogEntry): string;
export declare function openWhatsNew(): void;
export declare function closeWhatsNew(): void;
