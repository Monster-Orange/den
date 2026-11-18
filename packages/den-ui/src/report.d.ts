export interface ReportForm {
  kind?: string;
  title?: string;
  description?: string;
  [key: string]: unknown;
}
/** The adapter's answer for the fuller calls. */
export interface Answer<T = Record<string, unknown>> {
  status: number;
  data: T;
}
export type Headers = Record<string, string>;
export interface ReportAdapter {
  /** The simple way: "Filed as #N" with its link. */
  fileReport?: (
    payload: ReportForm & {
      preview?: { title: string; body: string } | null;
      /** The masked screenshot, a PNG data URL; null with "Don't include". */
      shot: string | null;
    },
  ) => Promise<{ number: number; url?: string } | { error: string }>;
  info?: () => Promise<{
    repos?: {
      repo: string;
      /** Who can see it; missing or anything else reads as "public". */
      visibility?: "public" | "private" | "internal";
      /** Who can see it, as words (shown after a private or internal pill). */
      audience?: string;
    }[];
    maxPerHour?: number;
    captureSeconds?: number;
  }>;
  diagnostics?: () => Promise<{ sections?: Record<string, string> }>;
  preview?: (form: ReportForm, h: Headers) => Promise<Answer>;
  send?: (form: ReportForm, h: Headers) => Promise<Answer>;
  githubSend?: (form: ReportForm, h: Headers) => Promise<Answer>;
  githubPoll?: (id: string) => Promise<Answer>;
  saveDraft?: (form: ReportForm, h: Headers) => Promise<Answer>;
  /**
   * Issue 403: whether the masked screenshot would go on to someone for
   * this destination; null or a failure: text only.
   */
  shotShare?: (
    repo: string,
  ) => Promise<{ share: boolean; recipient?: string } | null>;
}
export interface ReportOptions {
  lang?: string | (() => string);
  adapter?: ReportAdapter | null;
  busy?: (
    action: string,
    run: (headers: Headers) => Promise<unknown>,
    opts?: object,
  ) => Promise<unknown>;
  mine?: () => void;
  page?: () => string;
  screenshot?: boolean;
  library?: string;
}
export declare function configureReport(o?: ReportOptions): void;
/** The kit's own preview of a report: its title and body as text. */
export declare function localPreview(f: ReportForm & { diag?: object }): {
  title: string;
  body: string;
};
export declare function copyReport(text: string): Promise<void>;
/** What the browser can tell (page, size, language, …), by section. */
export declare function clientSections(win?: Window): Record<string, string>;
export declare function openReport(opts?: {
  prefill?: { kind?: string; title?: string; description?: string };
  /** Focus goes back here on close (default: what opened it). */
  opener?: Element | null;
  draft?: string;
}): Promise<unknown>;
