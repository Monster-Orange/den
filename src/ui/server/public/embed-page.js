/**
 * Issue 103: the embedded agent pane (/embed/p/<project>/agents/<id>),
 * inside another web app's frame. Only the origins in Settings ›
 * Embedding can frame it (the server's frame-ancestors). docs/embedding.md
 * is the contract.
 *
 * The handshake:
 *   1. Den → host   { type: "den:ready", version: 1 }, posted to each
 *                   listed origin (the browser delivers it only to the one
 *                   that is the parent);
 *   2. host → Den   { type: "den:hello" }. Den takes it only from its own
 *                   parent window, and only when event.origin is on the
 *                   list, exactly (never a prefix, never a part, never
 *                   `*`). That origin is the host from then on: anything
 *                   from another is ignored;
 *   3. Den mints a short-lived key for the person (POST /api/embed/keys:
 *      on this computer at once; elsewhere the person signs in in a Den
 *      pop-up, which hands the key back with postMessage to Den's own
 *      origin). The key stays in this page's memory: never in a URL,
 *      never in storage, never sent to the host. The frame sends no
 *      cookie (credentials: "omit");
 *   4. Den → host   { type: "den:connected", agent: { id, project, name } }.
 *
 * Then: { type: "den:size", height } whenever the pane's height changes,
 * { type: "den:sent" } after each Send, and { type: "den:error", code,
 * message } when something fails.
 */
import { makeComposer } from "/agent-composer.js";

let cfg = {};
try {
  cfg = JSON.parse(document.getElementById("den-embed")?.textContent ?? "");
} catch {
  cfg = {};
}
const ORIGINS = Array.isArray(cfg.origins)
  ? cfg.origins.filter((o) => typeof o === "string" && o)
  : [];

/** Whether `origin` is on `list`: exactly. */
export function originListed(origin, list) {
  return typeof origin === "string" && origin !== "" && list.includes(origin);
}

const MESSAGES = window.denMessages ?? {};
const LANG = document.documentElement.lang || "en";
/** The page's catalog (shell.js's MESSAGES), English the fallback. */
function t(key, vars) {
  const s = MESSAGES[LANG]?.[key] ?? MESSAGES.en?.[key] ?? key;
  return String(s).replace(/\{(\w+)\}/g, (m, k) =>
    vars && vars[k] != null ? String(vars[k]) : m,
  );
}

const $ = (id) => document.getElementById(id);
const framed = window.parent !== window;
let host = null;
let key = null;
let agent = null;
let popup = null;
let composer = null;
let connecting = null;

function post(msg) {
  if (host) window.parent.postMessage(msg, host);
}

function state(text, tone) {
  const el = $("emb-state");
  if (!el) return;
  el.textContent = text;
  el.hidden = !text;
  if (tone) el.dataset.tone = tone;
  else delete el.dataset.tone;
}

function failed(code, message) {
  state(t("emb.failed", { e: message }), "err");
  post({ type: "den:error", code, message });
}

let lastHeight = 0;
function sendSize() {
  const height = Math.ceil(document.documentElement.scrollHeight);
  if (!host || height === lastHeight) return;
  lastHeight = height;
  post({ type: "den:size", height });
}

/** The person signs in in a Den pop-up; it posts the key back. */
function needSignin() {
  key = null;
  state(t("emb.signinWhy"));
  const b = $("emb-signin");
  if (!b) return;
  b.hidden = false;
  b.onclick = () => {
    const q = new URLSearchParams({
      project: cfg.project,
      agent: cfg.agent,
      origin: host,
    });
    popup = window.open(
      `/embed/connect?${q}`,
      "den-embed-connect",
      "popup,width=520,height=640",
    );
  };
  post({
    type: "den:error",
    code: "signin_required",
    message: t("emb.signinWhy"),
  });
}

async function readJson(r) {
  try {
    return await r.json();
  } catch {
    return {};
  }
}

/** Ask Den for a key, for this host's origin. */
function connect() {
  connecting ??= (async () => {
    state(t("emb.connecting"));
    try {
      const s = await fetch("/api/session", {
        credentials: "omit",
        headers: { accept: "application/json" },
      });
      const sj = s.ok ? await readJson(s) : {};
      if (!sj.csrf) return needSignin();
      const r = await fetch("/api/embed/keys", {
        method: "POST",
        credentials: "omit",
        headers: { "content-type": "application/json", "x-den-csrf": sj.csrf },
        body: JSON.stringify({
          project: cfg.project,
          agent: cfg.agent,
          origin: host,
        }),
      });
      const j = await readJson(r);
      if (r.status === 401) return needSignin();
      if (!r.ok) return failed(j.code || "failed", j.error || `${r.status}`);
      gotKey(j);
    } catch (err) {
      failed("failed", err?.message || String(err));
    } finally {
      connecting = null;
    }
  })();
  return connecting;
}

function gotKey(j) {
  if (typeof j?.key !== "string" || !j.agent) return;
  key = j.key;
  agent = j.agent;
  $("emb-signin").hidden = true;
  $("emb-name").textContent = agent.name || agent.id;
  const open = $("emb-open");
  open.href = `/p/${encodeURIComponent(agent.project)}/agents/${encodeURIComponent(agent.id)}`;
  open.hidden = false;
  if (!composer) {
    composer = makeComposer({ t, name: agent.name || agent.id, send });
    $("emb-composer").append(composer.el);
  }
  state("");
  post({
    type: "den:connected",
    agent: { id: agent.id, project: agent.project, name: agent.name },
  });
  sendSize();
}

async function say(body) {
  return fetch("/api/embed/say", {
    method: "POST",
    credentials: "omit",
    headers: { "content-type": "application/json", "x-den-embed-key": key },
    body: JSON.stringify(body),
  });
}

/** The composer's Send: once more with a new key if this one expired. */
async function send(body) {
  if (!key) await connect();
  if (!key) throw new Error(t("emb.signinWhy"));
  let r = await say(body);
  if (r.status === 401) {
    key = null;
    await connect();
    if (!key) throw new Error(t("emb.signinWhy"));
    r = await say(body);
  }
  const j = await readJson(r);
  if (!r.ok) {
    post({ type: "den:error", code: j.code || "failed", message: j.error });
    throw new Error(j.error || `${r.status}`);
  }
  post({ type: "den:sent" });
}

window.addEventListener("message", (e) => {
  // The pop-up's key: from Den's own origin, from the window it opened.
  if (popup && e.source === popup) {
    if (e.origin === location.origin && e.data?.type === "den:key")
      gotKey(e.data);
    return;
  }
  // The host: this frame's parent, on the list, the same one each time.
  if (!framed || e.source !== window.parent) return;
  if (!originListed(e.origin, ORIGINS)) return;
  if (host && e.origin !== host) return;
  const d = e.data;
  if (!d || typeof d !== "object") return;
  if (d.type === "den:hello") {
    if (!host) {
      host = e.origin;
      void connect();
    } else if (agent)
      post({
        type: "den:connected",
        agent: { id: agent.id, project: agent.project, name: agent.name },
      });
  }
});

if (typeof ResizeObserver === "function")
  new ResizeObserver(sendSize).observe(document.body);

if (!framed) state(t("emb.notFramed"));
else
  for (const o of ORIGINS)
    window.parent.postMessage({ type: "den:ready", version: 1 }, o);
