/** den-ui 0.7.4 (issue 310): how a browser is signed in. */
export type AccountHow = "github" | "local" | "paired";
/** The role keys the kit has words for (kit.role.<key>). */
export type AccountRole = "owner" | "admin" | "member" | "guest";
export declare const ACCOUNT_HOWS: readonly AccountHow[];
export declare const ACCOUNT_ROLES: readonly AccountRole[];
/** The person's own block on Settings › Access: data only, no words. */
export interface AccountPanel {
  /** The person's name; the heading when given. */
  name?: string;
  /** Their login, with or without "@". */
  login?: string;
  /** A role key the kit words (owner, admin, member, guest); else as given. */
  role?: string;
  how: AccountHow;
  /** Sign out: a form post to url, csrf in a hidden field (field, "csrf"). */
  signOut?: { url: string; csrf?: string; field?: string };
  lang?: string;
}
/** The kit's word for a role key in `lang`; any other value as given. */
export declare function roleWord(
  role: string | null | undefined,
  lang?: string,
): string;
/**
 * The heading (name, else @login, else "Local"), @login · role, how this
 * browser is signed in, then Sign out (none without signOut). Escaped.
 */
export declare function accountPanelHtml(o?: AccountPanel): string;
