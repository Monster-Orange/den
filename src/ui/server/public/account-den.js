/**
 * Issue 310: Den on the kit's Account area (/kit/account-area.js). The
 * approved Account area mock (v2): one place for "me", separate from
 * Settings. The rail-foot account entry opens it, ?account=<section> opens
 * it on any page, and Settings › Access keeps a link "Your account →".
 *
 * Den passes its own records as the kit's fields (denAccountData):
 *
 *   Profile               who this browser is (GET /api/session), how and
 *                         since when it signed in (its linked-device record)
 *   Access and security   the owner's GitHub link (GET /api/web/owner) and
 *                         Pair a device (GET /api/web/pair's hostnames)
 *   Devices and sessions  the linked browsers (GET /api/web/sessions) and
 *                         the waiting codes (GET /api/web/waiting)
 *
 * and does what each button asks through Den's routes: sign this browser
 * out (/api/session/logout), sign one or every browser out
 * (/api/web/logout), approve a code (/api/web/approve), unlink the owner
 * (/api/web/owner/unlink). Linking GitHub and pairing a device still run
 * in Settings › Access; their buttons go there.
 *
 *   openAccount({ section?, opener? }) → Promise<area>
 */
import {
  accountAreaHref,
  accountSectionOf,
  openAccountArea,
} from "/kit/account-area.js";
import { kitT } from "/kit/strings.js";
import { deviceWords } from "./device-words.js";

const sh = () => (typeof window !== "undefined" ? window.denShell : null);
const t = (key, vars) => sh()?.t?.(key, vars) ?? key;

/** A waiting code lasts 10 minutes (web-sessions.ts). */
const CODE_MINUTES = 10;
const GITHUB_PROFILE = "https://github.com/settings/profile";

/** The role's words: the owner's is Den's own. */
function roleWords(role) {
  if (!role) return undefined;
  if (role === "owner") {
    const w = t("acct.roleOwner");
    return w && w !== "acct.roleOwner" ? w : "Owner";
  }
  return role;
}

/**
 * Den's records as the kit's fields (see the top). sessions or waiting
 * null: Den couldn't read them (signed out, or the server didn't answer).
 */
export function denAccountData({
  identity,
  owner,
  sessions,
  waiting,
  pairHosts,
  hub,
} = {}) {
  const id = identity || {};
  const list = Array.isArray(sessions) ? sessions : null;
  const mine = list ? list.find((s) => s.current) : null;
  const signedIn = !!mine;

  // Profile: a GitHub sign-in is that person; a local browser is the
  // owner's; a link or a code may be anyone's, so no person at all.
  const who =
    id.kind === "github" && id.login
      ? id
      : id.kind === "local" && id.owner && id.owner.login
        ? id.owner
        : null;
  // Issue 406: GitHub has no name: Hub's, when Hub's login is the same one
  // (the rail entry's name, so both read the same).
  const hubName =
    who &&
    hub &&
    typeof hub.name === "string" &&
    hub.name &&
    typeof hub.login === "string" &&
    hub.login.toLowerCase() === String(who.login).toLowerCase()
      ? hub.name
      : "";
  const name = (who && who.name) || hubName;
  const ownerLogin = owner?.owner?.login;
  const isOwner =
    who &&
    (who.role === "owner" ||
      (ownerLogin &&
        String(ownerLogin).toLowerCase() === String(who.login).toLowerCase()));
  const how =
    id.kind === "local"
      ? "local"
      : id.kind === "github"
        ? "github"
        : ["link", "code", "claim"].includes(id.via)
          ? id.via
          : "link";
  const profile = {
    ...(who
      ? {
          ...(name ? { name } : {}),
          login: who.login,
          ...(isOwner ? { role: roleWords("owner") } : {}),
          editHref: GITHUB_PROFILE,
        }
      : {}),
    how,
    ...(how !== "local" && mine?.createdAt ? { since: mine.createdAt } : {}),
    signOut: how !== "local" && signedIn,
    signOutEverywhere: true,
  };

  const hasOwner = !!(owner && owner.owner && owner.owner.login);
  const access = {
    github: hasOwner
      ? {
          login: owner.owner.login,
          ...(owner.owner.linkedAt ? { linkedAt: owner.owner.linkedAt } : {}),
          unlink: true,
        }
      : null,
    pair: Array.isArray(pairHosts) && pairHosts.length > 0,
  };

  const devices = list
    ? {
        list: list.map((s) => ({
          id: s.id,
          name: deviceWords(s.name),
          current: !!s.current,
          where: s.client || "",
          lastSeenAt: s.lastSeenAt,
        })),
        waiting: (Array.isArray(waiting) ? waiting : []).map((w) => ({
          code: w.code,
          minutes: CODE_MINUTES,
        })),
        pair: access.pair,
        signOutEverywhere: true,
      }
    : { error: true };

  return {
    profile,
    access,
    devices,
    settings: { href: "/settings#access" },
  };
}

/** GET a JSON route; null when it doesn't answer 2xx. */
async function get(url) {
  try {
    const r = await fetch(url, { cache: "no-store" });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

/** Who Hub says this is (the shell's state), when Hub is connected. */
function hubWho() {
  const h = sh()?.getState?.()?.hub;
  return h && h.state === "connected" ? { name: h.name, login: h.login } : null;
}

/** What Den knows now, as the kit's fields. */
async function load() {
  const [session, owner, sessions, waiting, pair] = await Promise.all([
    get("/api/session"),
    get("/api/web/owner"),
    get("/api/web/sessions"),
    get("/api/web/waiting"),
    get("/api/web/pair"),
  ]);
  return denAccountData({
    identity: session?.identity,
    owner,
    sessions: sessions ? sessions.sessions || [] : null,
    waiting: waiting ? waiting.waiting || [] : null,
    pairHosts: pair ? pair.hosts || [] : [],
    hub: hubWho(),
  });
}

/** Links a kit stylesheet once; resolves when it has loaded (or failed). */
function linkCss(name) {
  const id = "den-kit-" + name.replace(/\W/g, "-");
  if (document.getElementById(id)) return Promise.resolve();
  return new Promise((resolve) => {
    const l = document.createElement("link");
    l.id = id;
    l.rel = "stylesheet";
    l.href = "/kit/" + name;
    l.onload = l.onerror = () => resolve();
    document.head.append(l);
  });
}

let open = null;

/** Opens the Account area on `section` (see the top). */
export async function openAccount({ section, opener } = {}) {
  if (open) {
    if (section) open.select(section);
    return open;
  }
  const [data] = await Promise.all([
    load(),
    linkCss("account-area.css"),
    linkCss("switch.css"),
  ]);
  const api = (m, p, b) => sh().api(m, p, b);
  const goSettings = (hash) => {
    area.close();
    location.assign("/settings#" + hash);
  };
  let latest = data;
  const refresh = () =>
    load().then((d) => {
      latest = d;
      area.update(d);
    });
  const lang = sh()?.lang?.() || document.documentElement.lang || "en";
  const area = openAccountArea({
    ...data,
    current: section || accountSectionOf(location.search) || "profile",
    lang,
    product: "__DEN_TITLE__",
    opener,
    onClosed: () => {
      open = null;
    },
    onAction(act, { id, name }) {
      switch (act) {
        case "signout":
          return api("POST", "/api/session/logout", {}).then(() =>
            location.reload(),
          );
        case "signout-all":
          return api("POST", "/api/web/logout", {}).then(() =>
            location.reload(),
          );
        case "device-signout": {
          const me = latest.devices.list?.find((d) => d.id === id)?.current;
          return api("POST", "/api/web/logout", { id }).then(() => {
            if (me) return location.reload();
            area.toast(kitT(lang, "kit.acct.signedOut", { name }));
            return refresh();
          });
        }
        case "approve":
          return api("POST", "/api/web/approve", { code: id }).then(refresh);
        case "unlink":
          return api("POST", "/api/web/owner/unlink", {}).then(refresh);
        case "link":
          return goSettings("access.owner");
        case "pair":
          return goSettings("access.pair");
        case "retry":
          return refresh();
        default:
          return undefined;
      }
    },
  });
  open = area;
  return area;
}

/** ?account=<section> on load: the area opens on any page. */
export function openFromAddress() {
  const s = accountSectionOf(location.search);
  if (s) return openAccount({ section: s });
  return null;
}

export { accountAreaHref };
