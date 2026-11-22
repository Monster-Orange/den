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
      /**
       * Who can see it. Missing, "unknown" or anything else: not known, so
       * the form shows "Visibility not known" and a caution, never the
       * public pill nor a private claim. Pass it whenever the host knows.
       */
      visibility?: "public" | "private" | "internal" | "unknown";
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
/** A report target's visibility as the form reads it (issue 415). */
export type ReportVisibility = "public" | "private" | "internal" | "unknown";
/**
 * Issue 1127: a refusal for a listed name (the host's code "words", with
 * its hits) in the person's language: each hit's field, line and pattern
 * number, never the term. Null for any other answer.
 */
export declare function reportRefusalText(
  data: {
    code?: string;
    hits?: { field: string; line: number; index: number }[];
  } | null,
  lang?: string,
): string | null;
/**
 * Who can see a report sent to `repo` (one of info().repos): its
 * visibility ("unknown" unless the host said public, private or internal),
 * the audience (private and internal only), and the pill and the note
 * above Send as escaped markup. `lang` defaults to the form's.
 */
export declare function reportVisibility(
  repo: { repo?: string; visibility?: string; audience?: string } | null,
  lang?: string,
): {
  visibility: ReportVisibility;
  audience: string;
  pill: string;
  note: string;
};
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
