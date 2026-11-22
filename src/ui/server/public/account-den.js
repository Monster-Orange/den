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
 *   (and Waiting to be approved: GET /api/web/waiting, by ref)
 *
 * and does what each button asks through Den's routes, all in the area:
 * sign this browser out (/api/session/logout), sign one or every browser
 * out (/api/web/logout), link GitHub (/api/web/owner/link, GitHub's device
 * code) or unlink it (/api/web/owner/unlink), pair a device (POST
 * /api/web/pair: a one-time link and QR), approve a waiting device with the
 * code the person types from its screen (/api/web/approve, issue 819) or
 * deny it (/api/web/deny). Settings › Access keeps the install's rows.
 *
 *   openAccount({ section?, opener? }) → Promise<{ dialog, area, close }>
 */
import { accountSectionOf, openAccountArea } from "/kit/account-area.js";
import { approveRefusal, deviceWords, placeOf } from "./device-words.js";
import { qrSvg } from "./qr.js";

const sh = () => (typeof window !== "undefined" ? window.denShell : null);
const t = (key, en) => {
  const s = sh()?.tr?.(key, en);
  return typeof s === "string" && s ? s : en;
};

const GITHUB_PROFILE = "https://github.com/settings/profile";
const esc = (v) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
/** A link Den draws: only http(s), so a bad value never becomes javascript:. */
export const safeHref = (u) => {
  const s = String(u ?? "").trim();
  return /^https?:\/\/[^\s]/i.test(s) ? s : "";
};
const note = (text, bad) =>
  `<p class="den-aa-note${bad ? " bad" : ""}"${bad ? ' role="alert"' : ""}>${esc(text)}</p>`;
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
  waiting,
  now,
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

  // GitHub: the owner's link; nothing linked: Link, when Den has a GitHub
  // App client id to link with (else Not linked, alone). Owner unknown (the
  // route didn't answer): no row.
  const access = {
    github: ownerLogin
      ? {
          login: ownerLogin,
          ...(owner.owner.linkedAt ? { linkedAt: owner.owner.linkedAt } : {}),
          unlink: true,
        }
      : owner
        ? owner.clientId
          ? { link: true }
          : {}
        : null,
    // Pair a device: whenever Den could say where (no edge hostname yet,
    // and the area says so and points at Settings › Access › The edge).
    pair: Array.isArray(pairHosts),
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
        // Issue 819: by ref; the person types the code that computer shows.
        ...(waitingRows(waiting, now ?? Date.now()).length
          ? { waiting: waitingRows(waiting, now ?? Date.now()) }
          : {}),
      }
    : { error: true };

  return { profile, access, devices, settingsHref: "/settings#access" };
}

/** A request's age, in minutes (a request lasts 10). */
function askedWords(createdAt, now) {
  const at = Date.parse(createdAt ?? "");
  if (!Number.isFinite(at)) return "";
  const n = Math.max(0, Math.round((now - at) / 60_000));
  return n < 1
    ? t("acct.askedNow", "asked just now")
    : t("acct.askedMin", "asked {n} min ago").replace("{n}", String(n));
}

/** Waiting requests as the kit's typed rows; expired ones left out. */
export function waitingRows(list, now = Date.now()) {
  return (Array.isArray(list) ? list : [])
    .filter(
      (w) =>
        w &&
        typeof w.ref === "string" &&
        !(w.expiresAt && Date.parse(w.expiresAt) <= now),
    )
    .map((w) => ({
      ref: w.ref,
      title: deviceWords(w.device),
      detail: [placeOf(w.client), askedWords(w.createdAt, now)]
        .filter(Boolean)
        .join(" · "),
    }));
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

/** The edge hostnames a pairing link can be for (load() reads them). */
let pairHosts = null;

/** What Den knows now, as the kit's fields. */
async function load() {
  const [session, owner, sessions, pair, waiting] = await Promise.all([
    get("/api/session"),
    get("/api/web/owner"),
    get("/api/web/sessions"),
    get("/api/web/pair"),
    get("/api/web/waiting"),
  ]);
  pairHosts = pair ? pair.hosts || [] : null;
  return denAccountData({
    identity: session?.identity,
    owner,
    sessions: sessions ? sessions.sessions || [] : null,
    pairHosts,
    waiting: waiting?.waiting,
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
      shownRefs = (d.devices.waiting || []).map((w) => w.ref).join(",");
      open?.area.update(d);
    });
  const lang = sh()?.lang?.() || document.documentElement.lang || "en";
  // Timers that live while the area is open (a GitHub code being approved,
  // a pairing link's countdown, waiting requests coming and going).
  const timers = new Set();
  const later = (fn, ms) => {
    const id = setTimeout(() => {
      timers.delete(id);
      if (open) fn();
    }, ms);
    timers.add(id);
  };
  const flow = (name, html) => open?.area.flow(name, html);

  // Link GitHub: GitHub's device flow (the code, then GitHub's page).
  const link = async (button) => {
    button.disabled = true;
    let f;
    try {
      f = await sh().api("POST", "/api/web/owner/link", {});
    } catch (e) {
      button.disabled = false;
      flow("github", note(e.message, true));
      return;
    }
    const url =
      safeHref(f.verificationUri) || "https://github.com/login/device";
    flow(
      "github",
      `<p class="den-aa-note">${esc(t("acct.linkEnter", "Enter this code on GitHub and approve the app. It asks for no permissions."))}</p>` +
        `<p class="den-aa-gh"><b class="den-aa-ghcode">${esc(f.userCode)}</b> ` +
        `<a class="den-btn sm" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(t("set.ui.openGithub", "Open GitHub"))}</a></p>` +
        note(t("set.ui.waitingGithub", "Waiting for GitHub…")),
    );
    const poll = () =>
      get(`/api/web/owner/link/${encodeURIComponent(f.id)}`).then((b) => {
        if (b?.state === "pending") return later(poll, 1500);
        if (b?.state === "ok") {
          flow("github", "");
          return refresh();
        }
        button.disabled = false;
        flow(
          "github",
          note(
            b?.error || t("set.ui.linkFailed", "Linking failed. Try again."),
            true,
          ),
        );
      });
    later(poll, 1500);
  };

  // Pair a device: a one-time link and QR code for an edge hostname.
  const pairWith = async (host) => {
    let p;
    try {
      p = await sh().api("POST", "/api/web/pair", { host });
    } catch (e) {
      flow("pair", note(e.message, true));
      return;
    }
    const href = safeHref(p.url);
    if (!href) {
      flow(
        "pair",
        note(t("set.ui.linkFailed", "Linking failed. Try again."), true),
      );
      return;
    }
    const until = Date.parse(p.expiresAt);
    const draw = () => {
      const s = Math.max(0, Math.round((until - Date.now()) / 1000));
      flow(
        "pair",
        `<div class="den-aa-pair"><div class="den-aa-qr">${qrSvg(href, { scale: 4, margin: 4 })}</div>` +
          `<div>${note(t("set.ui.pairScan", "Scan it with the other device, or open the link there. It works once, until it expires (below), and signs that browser in for good."))}` +
          `<a class="den-aa-plink" href="${esc(href)}">${esc(href)}</a>` +
          `<p class="den-aa-note den-aa-left">${esc(
            s
              ? t("set.ui.expiresIn", "Expires in {s} s.").replace(
                  "{s}",
                  String(s),
                )
              : t(
                  "set.ui.pairExpired",
                  "This link expired. Pair again for a new one.",
                ),
          )}</p></div></div>`,
      );
      if (s) later(draw, 1000);
    };
    draw();
  };
  const pair = () => {
    const hosts = pairHosts || [];
    if (!hosts.length) {
      flow(
        "pair",
        note(
          t(
            "acct.noEdge",
            "No edge hostname routes to this Den yet, so another device has no address to open. Set one up in Settings, then pair.",
          ),
        ) +
          `<a class="den-aa-plink" href="/settings#access.edge">${esc(t("acct.edgeLink", "The edge in Settings →"))}</a>`,
      );
      return;
    }
    if (hosts.length === 1) return pairWith(hosts[0]);
    flow(
      "pair",
      `<p class="den-aa-gh"><select class="den-aa-host" aria-label="${esc(t("set.ui.edgeHost", "Edge hostname"))}">` +
        hosts
          .map((h) => `<option value="${esc(h)}">${esc(h)}</option>`)
          .join("") +
        `</select> <button type="button" class="den-btn primary sm" data-aa-act="pair-go">${esc(t("set.access.pair", "Pair a device"))}</button></p>`,
    );
  };

  // A waiting request: the code the person typed, or Deny.
  const answer = async (path, body, button) => {
    const release = sh()?.holdDots?.(button) ?? (async () => {});
    try {
      await sh().api("POST", path, body);
      await release();
    } catch (e) {
      await release();
      sh()?.toast?.(approveRefusal(e));
    }
    return refresh();
  };
  // New requests show up while it's open (and expired ones go).
  let shownRefs = (data.devices.waiting || []).map((w) => w.ref).join(",");
  const watchWaiting = () =>
    later(async () => {
      const w = await get("/api/web/waiting");
      const rows = waitingRows(w?.waiting);
      const refs = rows.map((r) => r.ref).join(",");
      if (w && refs !== shownRefs && latest.devices.list) {
        shownRefs = refs;
        latest = {
          ...latest,
          devices: { ...latest.devices, waiting: rows },
        };
        open?.area.update({ devices: latest.devices });
      }
      watchWaiting();
    }, 5000);

  open = openAccountArea({
    ...data,
    current: section || accountSectionOf(location.search) || "profile",
    lang,
    opener,
    onClose: () => {
      open = null;
      for (const id of timers) clearTimeout(id);
      timers.clear();
    },
    onAction(act, id, button, extra) {
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
        case "link":
          return link(button);
        case "pair":
          return pair();
        case "pair-go":
          return pairWith(
            button.parentElement?.querySelector(".den-aa-host")?.value,
          );
        case "approve":
          return answer(
            "/api/web/approve",
            { ref: id, code: extra?.code },
            button,
          );
        case "deny":
          return answer("/api/web/deny", { ref: id }, button);
        case "retry-devices":
          return refresh();
        default:
          return undefined;
      }
    },
  });
  watchWaiting();
  return open;
}
