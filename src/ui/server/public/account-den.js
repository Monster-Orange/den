/**
 * Issue 310: Den on the kit's Account area (/kit/account-area.js): one
 * place for "me", apart from Settings. The rail-foot account entry opens
 * it, ?account=<section> opens it on any page, and Settings › Access keeps
 * a link "Your account →".
 *
 * Den passes its own records as the kit's fields (denAccountData):
 *
 *   Profile               who this browser is (GET /api/session), how and
 *                         since when it signed in (its linked-device record)
 *   Access and security   the owner's GitHub link (GET /api/web/owner) and
 *                         Pair a device (GET /api/web/pair's hostnames)
 *   Devices and sessions  the linked browsers (GET /api/web/sessions)
 *
 * and does what each button asks through Den's routes: sign this browser
 * out (/api/session/logout), sign one or every browser out
 * (/api/web/logout), unlink the owner (/api/web/owner/unlink). Linking
 * GitHub, pairing a device and approving a waiting device (the person
 * types the code the device shows) still run in Settings › Access; Pair a
 * device goes there.
 *
 *   openAccount({ section?, opener? }) → Promise<{ dialog, area, close }>
 */
import { accountSectionOf, openAccountArea } from "/kit/account-area.js";
import { deviceWords, placeOf } from "./device-words.js";

const sh = () => (typeof window !== "undefined" ? window.denShell : null);
const t = (key, en) => {
  const s = sh()?.tr?.(key, en);
  return typeof s === "string" && s ? s : en;
};

const GITHUB_PROFILE = "https://github.com/settings/profile";
const same = (a, b) =>
  String(a ?? "").toLowerCase() === String(b ?? "").toLowerCase();

/**
 * Den's records as the kit's fields (see the top). sessions null: Den
 * couldn't read them (signed out, or the server didn't answer).
 */
export function denAccountData({
  identity,
  owner,
  sessions,
  pairHosts,
  hub,
} = {}) {
  const id = identity || {};
  const list = Array.isArray(sessions) ? sessions : null;
  const mine = list ? list.find((s) => s.current) : null;

  // A GitHub sign-in is that person; a local browser is the owner's; a
  // link or a code may be anyone's, so no person at all.
  const who =
    id.kind === "github" && id.login
      ? id
      : id.kind === "local" && id.owner && id.owner.login
        ? id.owner
        : null;
  // Issue 406: GitHub has no name: Hub's, when Hub's login is the same one
  // (the rail entry's name, so both read the same).
  const hubName =
    who && hub && hub.name && hub.login && same(hub.login, who.login)
      ? hub.name
      : "";
  const name = (who && who.name) || hubName;
  const ownerLogin = owner?.owner?.login;
  const isOwner =
    who &&
    (who.role === "owner" || (ownerLogin && same(ownerLogin, who.login)));
  const how =
    id.kind === "local" ? "local" : id.kind === "github" ? "github" : "paired";
  const profile = {
    ...(who
      ? {
          ...(name ? { name } : {}),
          login: who.login,
          ...(isOwner ? { role: t("acct.roleOwner", "Owner") } : {}),
          editHref: GITHUB_PROFILE,
        }
      : {}),
    how,
    ...(how !== "local" && mine?.createdAt ? { since: mine.createdAt } : {}),
    // Den's csrf is a header, so Sign out is Den's action, not a form. A
    // local browser on this machine has no session to end.
    signOut: how !== "local" && mine ? true : null,
    signOutAll: true,
  };

  const access = {
    github: ownerLogin
      ? {
          login: ownerLogin,
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
          // Issue 310: the place, never the address (a person's IP).
          where: placeOf(s.client),
          lastSeen: s.lastSeenAt,
        })),
        pair: access.pair,
        signOutAll: true,
      }
    : { error: true };

  return { profile, access, devices, settingsHref: "/settings#access" };
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
  const [session, owner, sessions, pair] = await Promise.all([
    get("/api/session"),
    get("/api/web/owner"),
    get("/api/web/sessions"),
    get("/api/web/pair"),
  ]);
  return denAccountData({
    identity: session?.identity,
    owner,
    sessions: sessions ? sessions.sessions || [] : null,
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
    if (section) open.area.show(section);
    return open;
  }
  const [data] = await Promise.all([load(), linkCss("account-area.css")]);
  // Every write goes through the working pop-up (busy-den.js names it); it
  // resolves undefined when the write didn't happen.
  const write = (name, url, body, button, vars) =>
    sh().busyAction(
      name,
      (headers) => sh().api("POST", url, body, { headers }),
      { button, ...(vars ? { vars } : {}) },
    );
  const done = (then) => (r) => (r === undefined ? undefined : then(r));
  const reload = done(() => location.reload());
  let latest = data;
  const refresh = () =>
    load().then((d) => {
      latest = d;
      open?.area.update(d);
    });
  const lang = sh()?.lang?.() || document.documentElement.lang || "en";
  open = openAccountArea({
    ...data,
    current: section || accountSectionOf(location.search) || "profile",
    lang,
    opener,
    onClose: () => {
      open = null;
    },
    onAction(act, id, button) {
      switch (act) {
        case "sign-out":
          return write("sign-out", "/api/session/logout", {}, button).then(
            reload,
          );
        case "sign-out-all":
          // This browser is signed out too: the page shows sign-in.
          return write("sign-out-all", "/api/web/logout", {}, button).then(
            reload,
          );
        case "sign-out-device": {
          const dev = latest.devices.list?.find((d) => d.id === id);
          const me = dev?.current;
          return write("sign-out-device", "/api/web/logout", { id }, button, {
            device: dev?.name || "",
          }).then(done(() => (me ? location.reload() : refresh())));
        }
        case "unlink":
          return write(
            "unlink-owner",
            "/api/web/owner/unlink",
            {},
            button,
          ).then(done(refresh));
        case "pair":
          open?.close();
          location.assign("/settings#access.pair");
          return undefined;
        case "retry-devices":
          return refresh();
        default:
          return undefined;
      }
    },
  });
  return open;
}
