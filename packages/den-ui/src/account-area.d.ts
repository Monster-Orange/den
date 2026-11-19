/** A section of the Account area, in the kit's order. */
export type AccountSection = "profile" | "access" | "devices" | "notifications";

/** How this browser signed in. */
export type AccountHow = "github" | "link" | "code" | "claim" | "local";

/** Profile: the person, how this browser signed in, the sign-outs. */
export interface AccountProfile {
  /** The person's name; left out: @login is the heading. */
  name?: string;
  login?: string;
  /** The role, in the host's words (Owner, say). */
  role?: string;
  /** A picture (relative or https); else the name's first letter. */
  avatar?: string;
  /** Edit on GitHub ↗ (opens in a new tab). */
  editHref?: string;
  how?: AccountHow;
  /** When this browser signed in (ISO). */
  since?: string;
  /** Sign out (this browser). */
  signOut?: boolean;
  signOutEverywhere?: boolean;
}

/** Access and security: GitHub, another way in, personal tokens. */
export interface AccountAccess {
  /** The linked GitHub account; null: not linked (Link GitHub). */
  github?: { login: string; linkedAt?: string; unlink?: boolean } | null;
  /** false: no Link GitHub button when it isn't linked. */
  link?: boolean;
  /** Another way in: Pair a device. */
  pair?: boolean;
  /** Personal access tokens; left out: no tokens part at all. */
  tokens?: {
    id: string;
    name: string;
    createdAt: string;
    lastUsedAt?: string;
  }[];
  newToken?: boolean;
}

/** Devices and sessions. */
export interface AccountDevices {
  /** Den couldn't read them: "Can’t list your devices" and Try again. */
  error?: boolean;
  list?: {
    id: string;
    /** The host's words for it (Safari on Mac). */
    name: string;
    current?: boolean;
    /** Where it signs in from (an address, "Local network"). */
    where?: string;
    lastSeenAt: string;
  }[];
  /** Codes waiting to be approved; minutes: how long one lasts (10). */
  waiting?: { code: string; minutes?: number }[];
  pair?: boolean;
  signOutEverywhere?: boolean;
}

/** Your notifications: one switch per choice. */
export interface AccountNotifications {
  items: {
    id: string;
    label: string;
    help?: string;
    on?: boolean;
    disabled?: boolean;
  }[];
}

/** The Account area's data. A section left out isn't drawn. */
export interface AccountAreaOptions {
  current?: AccountSection;
  profile?: AccountProfile;
  access?: AccountAccess;
  devices?: AccountDevices;
  notifications?: AccountNotifications;
  /** The rail foot's "Install settings →". */
  settings?: { href: string };
  /** The root's id (default "den-aa"). */
  id?: string;
  lang?: string;
  /** {product} in the kit's words (else setProduct's). */
  product?: string;
  now?: string | Date;
  zone?: string;
}

/** A button's action. */
export type AccountAction =
  | "signout"
  | "signout-all"
  | "unlink"
  | "link"
  | "pair"
  | "revoke-token"
  | "new-token"
  | "device-signout"
  | "approve"
  | "retry";

export interface AccountAreaHydrateOptions {
  /** A button's action; Sign out everywhere is asked first. */
  onAction?: (
    act: AccountAction,
    info: { id: string | null; name: string | null; button: HTMLElement },
  ) => Promise<unknown> | unknown;
  /** A notification switch; a reject puts it back. */
  onToggle?: (id: string, on: boolean) => Promise<unknown> | unknown;
  onSection?: (section: AccountSection) => void;
  onClose?: () => void;
  /** openAccountArea: after it closed. */
  onClosed?: () => void;
  /** false: leave ?account= in the address alone. */
  history?: boolean;
  lang?: string | (() => string);
  /** openAccountArea: what focus goes back to. */
  opener?: Element | null;
}

export interface AccountArea {
  select(section: AccountSection, o?: { quiet?: boolean }): void;
  current(): AccountSection;
  /** A short line at the pane's foot ("Signed out Safari on iPhone"). */
  toast(text: string | null): void;
  /** Search, as typing in the box would. */
  search(text: string): void;
  /** Draws the panes again from new data. */
  update(data: Partial<AccountAreaOptions>): void;
  destroy(): void;
}

export declare const ACCOUNT_SECTIONS: readonly {
  id: AccountSection;
  group: "account" | "signin" | "devices" | "notifications";
}[];
export declare function profilePaneHtml(
  p: AccountProfile,
  o?: AccountAreaOptions & { hidden?: boolean },
): string;
export declare function accessPaneHtml(
  a: AccountAccess,
  o?: AccountAreaOptions & { hidden?: boolean },
): string;
export declare function devicesPaneHtml(
  d: AccountDevices,
  o?: AccountAreaOptions & { hidden?: boolean },
): string;
export declare function notificationsPaneHtml(
  n: AccountNotifications,
  o?: AccountAreaOptions & { hidden?: boolean },
): string;
/** The Account area's markup. */
export declare function accountAreaHtml(o: AccountAreaOptions): string;
/** ?account=<section> → the section ("profile" for one it doesn't know), or null. */
export declare function accountSectionOf(search: string): AccountSection | null;
/** href with ?account=<section>, or without it (null). */
export declare function accountAreaHref(
  href: string,
  section: AccountSection | null,
): string;
/** Wires a drawn area. */
export declare function hydrateAccountArea(
  el: Element,
  opts?: AccountAreaHydrateOptions & { data?: AccountAreaOptions },
): AccountArea;
/** The area in a modal <dialog>; focus goes back to what opened it. */
export declare function openAccountArea(
  opts: AccountAreaOptions & AccountAreaHydrateOptions,
): AccountArea & { close(): void; dialog: HTMLDialogElement };
