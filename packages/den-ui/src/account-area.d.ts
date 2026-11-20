/** The Account area's sections, in the rail's order (issue 310). */
export type AccountSection = "profile" | "access" | "devices" | "notifications";
export declare const ACCOUNT_SECTIONS: AccountSection[];

/** How this browser is signed in, in the kit's words. */
export type AccountHow = "github" | "local" | "paired";

export interface AccountProfile {
  /** The display name; none (or the login itself): @login is the heading. */
  name?: string | null;
  login: string;
  role?: string | null;
  avatarUrl?: string | null;
  /** Edit on GitHub ↗ (none: left out). */
  editHref?: string | null;
  how: AccountHow;
  /** ISO-8601 UTC: "This browser, since …". */
  since?: string | null;
  /** Sign out: a plain POST form (none: no Sign out, a local browser). */
  signOut?: { url: string; csrf?: string } | null;
  /** Sign out everywhere (asked first). */
  signOutAll?: boolean;
}

export interface AccountToken {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt?: string | null;
}

export interface AccountAccess {
  github?: { login?: string; linkedAt?: string; unlink?: boolean } | null;
  /** Another way in: Pair a device. */
  pair?: boolean;
  /** Personal access tokens (none: the section is left out). */
  tokens?: AccountToken[];
  newToken?: boolean;
}

export interface AccountDevice {
  id: string;
  name: string;
  where?: string | null;
  lastSeen?: string | null;
  /** This browser: marked "This device". */
  current?: boolean;
}

export interface AccountDevices {
  list?: AccountDevice[];
  /** The list can't be read: Can't list your devices, Try again. */
  error?: boolean;
  /** Codes waiting to be approved. */
  waiting?: { code: string; minutes?: number }[];
  pair?: boolean;
  signOutAll?: boolean;
}

export interface AccountNotification {
  id: string;
  label: string;
  help?: string;
  on: boolean;
}

export interface AccountAreaData {
  id?: string;
  lang?: string;
  current?: AccountSection;
  /** "now" for relative times (tests, a server). */
  now?: string | number;
  /** The rail foot's "Install settings →" (none: left out). */
  settingsHref?: string | null;
  profile?: AccountProfile | null;
  access?: AccountAccess | null;
  devices?: AccountDevices | null;
  notifications?: AccountNotification[] | null;
}

export type AccountAction =
  | "unlink"
  | "pair"
  | "new-token"
  | "revoke-token"
  | "sign-out-device"
  | "sign-out-all"
  | "approve"
  | "retry-devices"
  | "notify";

export interface AccountAreaOptions extends AccountAreaData {
  /** The host's: a request goes through the kit's busy (pending()). */
  onAction?: (
    act: AccountAction,
    id: string | null,
    button: HTMLElement,
    extra: { on?: boolean },
  ) => unknown;
  onSection?: (section: AccountSection) => void;
  /** false: never touch ?account= in the address. */
  address?: boolean;
}

export interface AccountArea {
  root(): HTMLElement;
  show(section: AccountSection): void;
  current(): AccountSection;
  find(q: string): HTMLElement[];
  update(data: Partial<AccountAreaData>): void;
  destroy(): void;
}

/** The sections this data draws, in order. */
export declare function accountAreaSections(
  data?: AccountAreaData,
): AccountSection[];
/** The section ?account= names, or null with no ?account=. */
export declare function accountSectionOf(
  search: string,
  sections?: AccountSection[],
): AccountSection | null;
/** The whole area as markup. Pure. */
export declare function accountAreaHtml(data?: AccountAreaData): string;
/** The area in el, wired. */
export declare function mountAccountArea(
  el: HTMLElement,
  opts?: AccountAreaOptions,
): AccountArea;
/** The pop-up: a modal dialog holding the area. */
export declare function openAccountArea(
  opts?: AccountAreaOptions & {
    opener?: HTMLElement | null;
    onClose?: () => void;
  },
): { dialog: HTMLDialogElement; area: AccountArea; close(): void };
