/**
 * Issue 455 (mock v3, approved): Edge when something else holds
 * the port Den's address needs. A status card on top of the Edge page that
 * names the owner and says where Den serves instead; "What would you like
 * to do?" with the two ways out, in the approved order (Add Den to that
 * proxy, then Free port 80); the route for nginx, Caddy or Traefik to
 * paste, with Copy; Check again; and "Now": the container, the ports,
 * Den's proven address and the wanted one, each with what it answers as.
 *
 * Den never edits another project's files: the route is copy-paste. Check
 * again asks the server for a new check (POST /api/edge/address/check);
 * when the wanted address now reaches Den through that proxy, Den's links
 * switch to it and edge.publish: false is set for the person.
 *
 * addressCardView(state) is pure (HTML from /api/edge/address's JSON), so a
 * test needs no server.
 */
import { dockerState } from "./value-words.js";

const t = (key, vars) => globalThis.window?.denShell?.t?.(key, vars) ?? key;

function esc(v) {
  return String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
}

/**
 * A catalog line as HTML, its placeholders' values marked up: `marks`
 * maps a placeholder to "b" (bold) or "code" (an address). The words stay
 * the catalog's; only the values are wrapped.
 */
export function tHtml(key, vars, marks = {}) {
  const tokens = {};
  const v = {};
  for (const k of Object.keys(vars ?? {})) {
    tokens[k] = `\u0001${k}\u0002`;
    v[k] = tokens[k];
  }
  let s = esc(t(key, v));
  for (const [k, val] of Object.entries(vars ?? {})) {
    const tag = marks[k];
    const html = tag
      ? `<${tag}${tag === "code" ? ' translate="no"' : ""}>${esc(val)}</${tag}>`
      : esc(val);
    s = s.split(tokens[k]).join(html);
  }
  return s;
}

/** "21:48", in the viewer's own time. */
export function clock(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
}

/**
 * Whether the card has anything to say: Den works, just not at its address.
 * Another server answers there, or nothing does (issue 455: "Not reachable
 * yet", as the command line says it). No answer in time counts as nothing
 * only for a name on this machine: one only other machines resolve can't be
 * asked from here.
 */
export function cardShown(s) {
  if (!s || s.ok === false || !s.wanted || !s.address) return false;
  if (s.address === s.wanted) return false;
  if (s.wantedAnswer === "other" || s.wantedAnswer === "nothing") return true;
  return (
    s.wantedAnswer === "unknown" && s.directOk === true && localName(s.wanted)
  );
}

function localName(url) {
  const h = hostOf(url).toLowerCase();
  return h === "localhost" || h.endsWith(".localhost");
}

const PROXY_LABELS = { nginx: "nginx", caddy: "Caddy", traefik: "Traefik" };

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return String(url ?? "");
  }
}

/** The status line under the title. */
function statusHtml(s) {
  const time = clock(s.checkedAt);
  if (s.wantedAnswer !== "other")
    return tHtml(
      "edgeAddr.card.none",
      { wanted: s.wanted, address: s.address, time },
      { wanted: "code", address: "code" },
    );
  if (s.owner)
    return tHtml(
      "edgeAddr.card.held",
      {
        owner: s.owner.owner,
        kind: t(`edgeAddr.kind.${s.owner.kind}`),
        name: s.owner.name,
        address: s.address,
        time,
      },
      { owner: "b", name: "b", address: "code" },
    );
  if (s.answeredAs)
    return tHtml(
      "edgeAddr.card.heldBare",
      { owner: s.answeredAs, address: s.address, time },
      { owner: "b", address: "code" },
    );
  return tHtml(
    "edgeAddr.card.unknown",
    { address: s.address, time },
    { address: "code" },
  );
}

/** What Check again says when the address still isn't Den. */
export function stillLine(s) {
  return s.answeredAs
    ? t("edgeAddr.check.still", { owner: s.answeredAs })
    : t("edgeAddr.check.stillUnknown");
}

/** The "Free port N" pane's one paragraph (no command pasted at the person). */
function freeHtml(s) {
  const o = s.owner;
  const port = s.port;
  if (o?.denEdge)
    return `<p>${tHtml("edgeAddr.free.takeOver", { name: o.name }, { name: "b" })}</p>`;
  if (o?.kind === "container")
    return `<p>${tHtml("edgeAddr.free.container", { name: o.name, port }, { name: "b" })}</p>`;
  if (o)
    return `<p>${tHtml("edgeAddr.free.process", { owner: o.owner, name: o.name, port }, { owner: "b" })}</p>`;
  return `<p>${tHtml("edgeAddr.free.unknown", { port })}</p>`;
}

function pill(text, tone) {
  return `<span class="addr-pill ${tone}">${esc(text)}</span>`;
}

function nowHtml(s) {
  const rows = [];
  const e = s.edge;
  if (e) {
    const state =
      e.state === "absent"
        ? pill(t("edgeAddr.container.notCreated"), "warn")
        : pill(dockerState(e.state), e.state === "running" ? "ok" : "warn");
    rows.push([
      t("edgeAddr.k.container"),
      `<span class="mono" translate="no">${esc(e.container)}</span> ${state}`,
    ]);
    if (Array.isArray(e.ports) && e.ports.length)
      rows.push([
        t("edgeAddr.k.ports"),
        e.ports
          .map((p) =>
            esc(
              !p.held
                ? t("edgeAddr.port.free", { port: p.port })
                : p.by
                  ? t("edgeAddr.port.heldBy", {
                      port: p.port,
                      owner: p.by.owner,
                    })
                  : t("edgeAddr.port.held", { port: p.port }),
            ),
          )
          .join(" · "),
      ]);
  }
  rows.push([
    t("edgeAddr.k.address"),
    `<span class="mono" translate="no">${esc(s.address)}</span> ` +
      pill(t("edgeAddr.checked.den"), "neutral"),
  ]);
  rows.push([
    t("edgeAddr.k.wanted"),
    `<span class="mono" translate="no">${esc(s.wanted)}</span> ` +
      pill(
        s.wantedAnswer === "other"
          ? s.answeredAs
            ? t("edgeAddr.answers.as", { owner: s.answeredAs })
            : t("edgeAddr.answers.notDen")
          : t("edgeAddr.answers.nothing"),
        "warn",
      ),
  ]);
  return (
    `<section class="addr-box" aria-labelledby="addr-h-now"><h3 id="addr-h-now">${esc(t("edgeAddr.now"))}</h3><dl class="addr-now">` +
    rows
      .map(
        ([k, v]) =>
          `<div class="addr-row"><dt>${esc(k)}</dt><dd>${v}</dd></div>`,
      )
      .join("") +
    `</dl></section>`
  );
}

/** The card's HTML for /api/edge/address's state ("" when it has nothing to say). */
export function addressCardView(s, opts = {}) {
  if (!cardShown(s)) return "";
  const option = opts.option ?? "proxy";
  const kind = opts.kind ?? s.routeKind ?? "nginx";
  const routes = s.routes ?? null;
  const port = s.port;
  const host = hostOf(s.wanted);
  const title =
    s.wantedAnswer === "other"
      ? t("edgeAddr.card.title", { port })
      : t("edgeAddr.card.titleNone");
  const held = s.wantedAnswer === "other";
  const kinds = routes
    ? `<div class="addr-kinds" role="group" aria-label="${esc(t("edgeAddr.proxy.kinds"))}">` +
      Object.keys(PROXY_LABELS)
        .map(
          (k) =>
            `<button type="button" class="addr-chip" data-kind="${k}" aria-pressed="${k === kind}" translate="no">${PROXY_LABELS[k]}</button>`,
        )
        .join("") +
      `</div>` +
      `<div class="addr-snip"><pre tabindex="0" id="addr-snippet" translate="no"><code>${esc(routes[kind] ?? "")}</code></pre>` +
      `<button type="button" class="addr-copy" id="addr-copy">${esc(t("edgeAddr.copy"))}</button></div>`
    : "";
  const proxyPane =
    `<div class="addr-pane" data-pane="proxy"${option === "proxy" ? "" : " hidden"}>` +
    `<p>${tHtml("edgeAddr.proxy.body", { port, host }, { host: "code" })}</p>` +
    kinds +
    `<p>${tHtml("edgeAddr.proxy.after", { wanted: s.wanted }, { wanted: "code" })}</p>` +
    `</div>`;
  const takeOver = !!s.owner?.denEdge;
  const freePane =
    `<div class="addr-pane" data-pane="free"${option === "free" ? "" : " hidden"}>` +
    freeHtml(s) +
    (takeOver
      ? `<button type="button" class="btn" id="addr-take-over">${esc(t("edgeAddr.opt.takeOver"))}</button>`
      : "") +
    `</div>`;
  const choices = held
    ? `<section class="addr-box" aria-labelledby="addr-h-what"><h3 id="addr-h-what">${esc(t("edgeAddr.what"))}</h3>` +
      `<div class="addr-opts" role="group">` +
      `<button type="button" class="addr-opt" data-opt="proxy" aria-pressed="${option === "proxy"}">${esc(t("edgeAddr.opt.proxy"))}</button>` +
      `<button type="button" class="addr-opt" data-opt="free" aria-pressed="${option === "free"}">${esc(takeOver ? t("edgeAddr.opt.takeOver") : t("edgeAddr.opt.free", { port }))}</button>` +
      `</div>` +
      proxyPane +
      freePane +
      `<div class="addr-check-row"><button type="button" class="btn primary" id="addr-check">${esc(t("edgeAddr.check"))}</button>` +
      `<span class="addr-out" id="addr-check-out" aria-live="polite">${esc(opts.result ?? stillLine(s))}</span></div>` +
      `</section>`
    : `<section class="addr-box"><div class="addr-check-row"><button type="button" class="btn primary" id="addr-check">${esc(t("edgeAddr.check"))}</button>` +
      `<span class="addr-out" id="addr-check-out" aria-live="polite">${esc(opts.result ?? "")}</span></div></section>`;
  return (
    `<div class="addr-card" data-address-card>` +
    `<div class="addr-status" role="status"><span class="addr-dot" aria-hidden="true"></span><div>` +
    `<h2 class="addr-title">${esc(title)}</h2><p class="addr-line">${statusHtml(s)}</p></div></div>` +
    choices +
    nowHtml(s) +
    `</div>`
  );
}

/** The line Check again leaves, from the new state. */
export function checkResult(s) {
  if (s && s.wantedAnswer === "den")
    return t("edgeAddr.check.done", { wanted: s.wanted });
  return s ? stillLine(s) : "";
}

/**
 * Draw the card into `host` and wire it. `shell` is window.denShell (api,
 * busyAction). `onState` gets each state it draws (the Edge page's sub line
 * follows it). Resolves with the state it drew.
 */
export async function mountAddressCard(
  host,
  shell = globalThis.window?.denShell,
  onState = null,
) {
  if (!host) return null;
  let s = null;
  try {
    const r = await fetch("/api/edge/address", { cache: "no-store" });
    s = await r.json();
  } catch {
    s = null;
  }
  const view = {
    option: "proxy",
    kind: s?.routeKind ?? "nginx",
    result: undefined,
  };
  const draw = () => {
    host.innerHTML = addressCardView(s, view);
    host.hidden = !host.innerHTML;
    onState?.(s);
  };
  draw();
  host.addEventListener("click", (e) => {
    const el = e.target?.closest?.("button");
    if (!el || !host.contains(el)) return;
    if (el.dataset.opt) {
      view.option = el.dataset.opt;
      draw();
      host.querySelector(`[data-opt="${view.option}"]`)?.focus();
      return;
    }
    if (el.dataset.kind) {
      view.kind = el.dataset.kind;
      draw();
      host.querySelector(`[data-kind="${view.kind}"]`)?.focus();
      return;
    }
    if (el.id === "addr-copy") {
      const text = s?.routes?.[view.kind] ?? "";
      const done = () => {
        el.textContent = t("edgeAddr.copied");
      };
      if (navigator.clipboard?.writeText)
        navigator.clipboard.writeText(text).then(done, () => {});
      return;
    }
    if (el.id === "addr-check" || el.id === "addr-take-over") {
      const path =
        el.id === "addr-check"
          ? "/api/edge/address/check"
          : "/api/edge/address/take-over";
      const name =
        el.id === "addr-check" ? "check-edge-address" : "edge-take-over";
      const run = (headers) => shell.api("POST", path, {}, { headers });
      const p = shell?.busyAction
        ? shell.busyAction(name, run, { button: el })
        : run({});
      Promise.resolve(p).then(
        (next) => {
          if (next && typeof next === "object") s = next;
          view.result = checkResult(s);
          if (s?.wantedAnswer === "den") {
            host.innerHTML = `<p class="addr-done" role="status">${esc(view.result)}</p>`;
            onState?.(s);
            globalThis.window?.dispatchEvent?.(
              new CustomEvent("den:address-changed", { detail: s }),
            );
            return;
          }
          draw();
        },
        (err) => {
          view.result = t("edgeAddr.check.failed", {
            error: String(err?.message ?? err ?? ""),
          });
          draw();
        },
      );
    }
  });
  return s;
}
