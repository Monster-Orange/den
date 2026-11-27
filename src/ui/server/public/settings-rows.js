import { projectLabel } from "./workspace-picker.js";
import { scopeText } from "./settings-page.js";

const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const slug = (id) => String(id).replace(/[^a-zA-Z0-9_-]/g, "-");
const SWATCHES = ["accent", "ok", "warn", "bad", "bg", "surface", "text"];

export async function settingsCtx(deps) {
  const shell = deps.shell;
  let wsPayload = null;
  const wsName = (slug) => (wsPayload ? projectLabel(wsPayload, slug) : slug);
  const ctx = {
    data: {},
    appearance: {},
    scope: null,
    workspace: null,
    workspaces: [],
    wsSettings: null,
    shell,
    post,
    setAppearance: async (patch) => {
      await deps.appearance.setAppearance(patch);
      ctx.appearance = deps.appearance.appearanceState();
      return true;
    },
    saveWorkspace,
    wsName,
    loadWorkspaceSettings,
  };

  async function getJson(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${url}: ${r.status}`);
    return r.json();
  }
  /**
   * BUSY-1: a save through the working pop-up: nothing shows for a fast
   * one (the row says Saved itself); a slow one says it is saving, and a
   * failure says so with Try again. The control pressed waits with it.
   * The answer's data, or null.
   */
  function busySave(url, body) {
    const sh = window.denShell;
    const run = (headers) => sh.api("POST", url, body, { headers });
    if (!sh?.busyAction) return run({}).catch(() => null);
    const el = document.activeElement;
    const button =
      el && el !== document.body && "disabled" in el ? el : undefined;
    return sh.busyAction("save", run, { button, toastFast: false });
  }
  /** POST /api/settings; merges the reply. true when saved. */
  async function post(patch) {
    const reply = await busySave("/api/settings", patch);
    if (!reply) return false;
    // Every setting the reply returns (0.4.13): a fixed list here left a
    // new row's pressed button on its old value until a reload.
    for (const [k, v] of Object.entries(reply))
      if (k !== "ok" && v !== undefined) ctx.data[k] = v;
    return true;
  }
  async function saveWorkspace(patch) {
    if (!ctx.workspace) return false;
    const reply = await busySave("/api/workspaces/settings", {
      workspace: ctx.workspace,
      ...patch,
    });
    if (!reply) return false;
    // Every field the reply returns (issue 160: the policy rows too).
    const { ok: _ok, ...fields } = reply;
    ctx.wsSettings = { ...(ctx.wsSettings || {}), ...fields };
    return true;
  }
  async function loadWorkspaceSettings() {
    // 0.4.1: under an invalid config it answers 422; the rows show none.
    if (window.denShell?.configInvalid?.() === true) {
      ctx.wsSettings = null;
      return;
    }
    ctx.wsSettings = ctx.workspace
      ? await getJson(
          `/api/workspaces/settings?workspace=${encodeURIComponent(ctx.workspace)}`,
        ).catch(() => null)
      : null;
  }

  // Everything the rows read, read once (GET only).
  const [data, appearance, scope] = await Promise.all([
    getJson("/api/settings").catch(() => null),
    deps.appearance.ensureAppearance().catch(() => ({})),
    getJson("/api/scope").catch(() => null),
  ]);
  // 0.4.1: under an invalid config /api/workspaces answers 422; slugs then.
  wsPayload =
    shell.configInvalid?.() === true
      ? null
      : await getJson("/api/workspaces").catch(() => null);
  if (!data) return null;
  ctx.data = data;
  ctx.appearance = appearance;
  ctx.scope = scope;
  // The Workspace rows follow the view; with All active, they ask which.
  ctx.workspaces = scope?.inView || [];
  const askWs = !scope || scope.scope === "all";
  const q = new URLSearchParams(location.search);
  // #80: ?project=, with ?ws= read as its old name.
  const wanted = q.get("project") || q.get("ws");
  ctx.workspace = !askWs
    ? scope.scope
    : ctx.workspaces.includes(wanted)
      ? wanted
      : ctx.workspaces.includes(scope?.focus)
        ? scope.focus
        : (ctx.workspaces[0] ?? null);
  ctx.askWorkspace = askWs && ctx.workspaces.length > 0;
  await loadWorkspaceSettings();
  return ctx;
}

const CLI = "__DEN_CLI__";
const CLI_RE = CLI.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const CMD = new RegExp(
  `(^|[\\s(:])${CLI_RE} (config|gate|web|hub|edge|agents|apps)\\b`,
);
const SENTENCE = new RegExp(
  `(?<=[.!?])\\s+(?=[^\\sa-z]|${CLI_RE} )|(?<=。)(?=\\S)`,
);

export function splitHelp(text) {
  const parts = String(text ?? "")
    .split(SENTENCE)
    .filter((p) => p.trim());
  const at = parts.findIndex((p, i) => i > 0 && CMD.test(p));
  const prose = at < 0 ? parts : parts.slice(0, at);
  const cmd = at < 0 ? [] : parts.slice(at);
  let lead = prose[0] ?? "";
  const m = lead.match(CMD);
  if (m) {
    const i = m.index + m[1].length;
    cmd.unshift(lead.slice(i).replace(/\)?[.。]?$/, ""));
    const end = lead.endsWith("。") ? "。" : ".";
    lead = lead.slice(0, i).replace(/[\s(:]+$/, "");
    if (!/[.!?。]$/.test(lead)) lead += end;
  }
  return { lead, more: prose.slice(1), cmd };
}

function cmdHtml(p) {
  const m = p.match(CMD);
  const i = m ? m.index + m[1].length : -1;
  const rest = i < 0 ? "" : p.slice(i).replace(/\.$/, "");
  const code =
    (i === 0 && rest === p) ||
    (i >= 0 &&
      /^\S+ (config \S+|gate settings( \S+)+|gate (box|runner) .+)$/.test(rest));
  return code
    ? `<p>${esc(p.slice(0, i))}<code>${esc(rest)}</code></p>`
    : `<p>${esc(p)}</p>`;
}

export function helpHtml(text, did, after, L) {
  const { lead, more, cmd } = splitHelp(text);
  const fold =
    more.length || cmd.length
      ? `<details class="set-more"><summary>${esc(L(more.length ? "set.ui.more" : "set.ui.cmd"))}</summary>` +
        more.map((p) => `<p>${esc(p)}</p>`).join("") +
        cmd.map(cmdHtml).join("") +
        "</details>"
      : "";
  return `<div class="d"><span id="${did}">${esc(lead)}${after}</span>${fold}</div>`;
}

export function rowKit(
  ctx,
  { redraw, root = null, idPrefix = "", scopeTag = true },
) {
  const shell = ctx.shell;
  const L = (k, v) => shell.t(k, v);
  const wsName = ctx.wsName;
  const $ = (id) =>
    root
      ? root.querySelector(`#${CSS.escape(id)}`)
      : document.getElementById(id);
  const rid = (r) => idPrefix + slug(r.id);
  function tag(from) {
    return from
      ? ` <span class="den-tagx" title="${esc(L("set.ui.from", { from }))}">${esc(from)}</span>`
      : "";
  }
  /**
   * A row's value while its save is out: { v }. A redraw then (a plugin's
   * rows, the appearance, the hash) draws what was just chosen, not the
   * old value, so a switch doesn't flip back and get a second save
   * (issue 424). Only single-value controls: a list row saves a part.
   */
  const pending = new Map();
  const PENDING_TYPES = [
    "toggle",
    "number",
    "select",
    "text",
    "seg",
    "theme",
    "radio",
  ];
  function value(r) {
    if (pending.has(r.id)) return pending.get(r.id).v;
    try {
      return r.read(ctx);
    } catch {
      return undefined;
    }
  }
  function opts(o) {
    const v = typeof o === "function" ? o(ctx) : o;
    return Array.isArray(v) ? v : [];
  }
  // A custom control draws itself (it may act through its own API rather
  // than save a value: Settings › Access), so it renders whether or not the
  // row has a write.
  function drawsItself(r) {
    return (
      r.control?.type === "custom" && typeof r.control.render === "function"
    );
  }
  function drawRow(r) {
    const id = rid(r);
    const lid = `l-${id}`;
    const cid = `c-${id}`;
    const did = `d-${id}`;
    const v = value(r);
    const t = r.control?.type || "readonly";
    const ro = !r.write && !drawsItself(r);
    const single = ["number", "select", "toggle", "text"].includes(t);
    const label = single
      ? `<label class="l" id="${lid}" for="${cid}">${esc(r.label)}</label>`
      : `<span class="l" id="${lid}">${esc(r.label)}</span>`;
    const desc = `aria-describedby="${did}"`;
    let ctl = "";
    if (ro || t === "readonly") {
      ctl = `<output class="set-ro" id="${cid}" aria-labelledby="${lid}" ${desc}>${esc(v ?? "")}</output>`;
    } else if (t === "seg" || t === "theme") {
      ctl =
        `<div class="seg" role="group" aria-labelledby="${lid}" ${desc}>` +
        opts(r.control.options)
          .map(
            (o) =>
              `<button type="button" data-v="${esc(o.value)}" data-focus-key="${id}:${esc(o.value)}" aria-pressed="${String(o.value) === String(v) || !!o.selected}">${esc(o.label)}</button>`,
          )
          .join("") +
        "</div>";
      if (t === "theme") {
        const notice = r.control.notice?.(ctx);
        ctl +=
          (notice
            ? `<p class="set-warn" role="status">${esc(notice)}</p>`
            : "") +
          `<div class="swatches" aria-label="${esc(L("set.ui.swatches"))}" role="img">${swatches()}</div>`;
      }
    } else if (t === "radio") {
      ctl =
        `<div class="set-radios" role="radiogroup" aria-labelledby="${lid}" ${desc}>` +
        opts(r.control.options)
          .map(
            (o) =>
              `<label class="set-radio${o.disabled ? " off" : ""}"><input type="radio" name="${cid}" value="${esc(o.value)}" data-focus-key="${id}:${esc(o.value)}"${String(o.value) === String(v) ? " checked" : ""}${o.disabled ? " disabled" : ""}>` +
              `<span>${esc(o.label)}</span>${(o.tags || [])
                .filter(Boolean)
                .map((x) => `<span class="set-tag">${esc(x)}</span>`)
                .join("")}</label>`,
          )
          .join("") +
        "</div>";
    } else if (t === "select") {
      ctl =
        `<select id="${cid}" data-focus-key="${id}" ${desc}>` +
        opts(r.control.options)
          .map(
            (o) =>
              `<option value="${esc(o.value)}"${String(o.value) === String(v) ? " selected" : ""}>${esc(o.label)}</option>`,
          )
          .join("") +
        "</select>";
      // Issue 172: a select may say what its value means (quiet hours).
      const notice = r.control.notice?.(ctx);
      if (notice) ctl += `<p class="set-warn" role="status">${esc(notice)}</p>`;
    } else if (t === "number") {
      const c = r.control;
      ctl =
        `<input type="number" id="${cid}" data-focus-key="${id}" value="${esc(v)}"` +
        (c.min != null ? ` min="${c.min}"` : "") +
        (c.max != null ? ` max="${c.max}"` : "") +
        (c.step != null ? ` step="${c.step}"` : "") +
        ` ${desc}>` +
        (c.unit
          ? `<span class="set-unit" aria-hidden="true">${esc(c.unit)}</span>`
          : "");
    } else if (t === "text") {
      // Issue 158: a field may stop at the server's limit.
      const ml = r.control.maxLength;
      const max = Number.isInteger(ml) ? ` maxlength="${ml}"` : "";
      ctl = `<input type="text" id="${cid}" data-focus-key="${id}" value="${esc(v)}"${max} ${desc}>`;
    } else if (t === "toggle") {
      ctl = `<input type="checkbox" class="set-check" id="${cid}" data-focus-key="${id}"${v ? " checked" : ""} ${desc}>`;
      // Bell v6: a switch may say what being off means (waiting).
      const notice = r.control.notice?.(ctx);
      if (notice) ctl += `<p class="set-warn" role="status">${esc(notice)}</p>`;
    } else if (t === "langmap") {
      const map = v || {};
      const eds = opts(r.control.options);
      ctl =
        `<div class="set-langs" role="group" aria-labelledby="${lid}" ${desc}>` +
        opts(r.control.languages)
          .map((l) => {
            const sid = `${cid}-${slug(l.key)}`;
            return (
              `<div class="set-lang"><label for="${sid}">${esc(l.name)}</label>` +
              `<select id="${sid}" data-lang="${esc(l.key)}" data-focus-key="${sid}">` +
              `<option value="">${esc(L("set.ui.inherit"))}</option>` +
              eds
                .map(
                  (e) =>
                    `<option value="${esc(e.value)}"${map[l.key] === e.value ? " selected" : ""}>${esc(e.label)}</option>`,
                )
                .join("") +
              "</select></div>"
            );
          })
          .join("") +
        "</div>";
    } else if (t === "navlist") {
      ctl = navlist(r, v, lid, desc);
    } else if (t === "pins") {
      const pins = v || [];
      ctl = pins.length
        ? `<div class="navlist" role="list" aria-labelledby="${lid}" ${desc}>` +
          pins
            .map(
              (p, i) =>
                `<div class="it" role="listitem"><span class="nm den-mono">${esc(p)}</span>` +
                `<button type="button" class="den-btn sm" data-pin-move="${esc(p)}" data-d="-1" data-focus-key="pin-up-${esc(p)}"${i === 0 ? " disabled" : ""} aria-label="${esc(L("set.ui.moveUp", { name: p }))}">↑</button>` +
                `<button type="button" class="den-btn sm" data-pin-move="${esc(p)}" data-d="1" data-focus-key="pin-down-${esc(p)}"${i === pins.length - 1 ? " disabled" : ""} aria-label="${esc(L("set.ui.moveDown", { name: p }))}">↓</button>` +
                `<button type="button" class="den-btn sm" data-pin-remove="${esc(p)}" data-focus-key="pin-x-${esc(p)}" aria-label="${esc(L("set.ui.unpinX", { name: p }))}">${esc(L("act.unpin"))}</button></div>`,
            )
            .join("") +
          "</div>"
        : `<output class="set-ro" aria-labelledby="${lid}" ${desc}>${esc(L("set.ui.noPins"))}</output>`;
    } else if (t === "workspace-editor") {
      ctl = wsEditor(v, lid, cid, desc);
    } else if (t === "custom") {
      ctl = `<div class="set-custom" id="${cid}" role="group" aria-labelledby="${lid}" ${desc}></div>`;
    }
    const dist = r.scope === "distribution";
    const note = dist
      ? ` ${esc(
          ctx.data.distribution?.file
            ? L("set.ui.setByIn", { file: ctx.data.distribution.file })
            : L("set.ui.setBy"),
        )}`
      : "";
    return (
      `<div class="set-row" id="setting-${id}" data-setting="${esc(r.id)}" data-scope="${esc(r.scope)}">` +
      `<div class="row">${label}<div class="ctl">${ctl}</div>` +
      (scopeTag
        ? `<span class="set-scope" data-scope="${esc(r.scope)}">${esc(scopeText(r, ctx.workspace ? wsName(ctx.workspace) : null, L))}</span>`
        : "") +
      "</div>" +
      // helpInControl: the control shows its own help line (mock v6);
      // the description stays for screen readers.
      (r.helpInControl
        ? `<div class="d den-sr" id="${did}">${esc(r.description)}${note}${tag(r.from)}</div>`
        : helpHtml(r.description, did, note + tag(r.from), L)) +
      `<span class="set-saved" role="status" id="s-${id}"></span>` +
      "</div>"
    );
  }
  function navlist(r, v, lid, desc) {
    const hidden = (v && v.hidden) || [];
    const items = shell.orderedNav();
    const groups = shell.groups();
    const gl = (id) => {
      const g = groups.find((x) => x.id === id);
      return g ? shell.t(g.label) : id;
    };
    return (
      `<div class="navlist" role="list" aria-labelledby="${lid}" ${desc}>` +
      items
        .map((n, i) => {
          const off = hidden.includes(n.id);
          const name = shell.t(n.label);
          const sameGroup = (j) => items[j] && items[j].group === n.group;
          return (
            `<div class="it${off ? " off" : ""}" role="listitem"><span class="nm">${esc(name)} <span class="set-grp">· ${esc(gl(n.group))}</span>${tag(n.from)}</span>` +
            `<button type="button" class="den-btn sm" data-move="${esc(n.id)}" data-d="-1" data-focus-key="nav-up-${esc(n.id)}"${sameGroup(i - 1) ? "" : " disabled"} aria-label="${esc(L("set.ui.moveUp", { name }))}">↑</button>` +
            `<button type="button" class="den-btn sm" data-move="${esc(n.id)}" data-d="1" data-focus-key="nav-down-${esc(n.id)}"${sameGroup(i + 1) ? "" : " disabled"} aria-label="${esc(L("set.ui.moveDown", { name }))}">↓</button>` +
            `<button type="button" class="den-btn sm" data-hide="${esc(n.id)}" data-focus-key="nav-hide-${esc(n.id)}" aria-pressed="${off}" aria-label="${esc(L(off ? "set.ui.showX" : "set.ui.hideX", { name }))}">${esc(L(off ? "set.ui.show" : "set.ui.hide"))}</button></div>`
          );
        })
        .join("") +
      "</div>"
    );
  }
  function wsEditor(v, lid, cid, desc) {
    if (!ctx.workspace)
      return `<output class="set-ro" aria-labelledby="${lid}" ${desc}>${esc(L("set.ui.noProject"))}</output>`;
    const eds = ctx.data.editors || [];
    const def =
      eds.find(
        (e) => e.key === (ctx.data.editor ?? eds.find((x) => x.available)?.key),
      )?.name || L("set.ui.none");
    const radio = (val, name, tagText) =>
      `<label class="set-radio"><input type="radio" name="${cid}" value="${esc(val)}" data-focus-key="ws-ed-${esc(val)}"${(v || "") === val ? " checked" : ""}>` +
      `<span>${esc(name)}</span>${tagText ? `<span class="set-tag">${esc(tagText)}</span>` : ""}</label>`;
    return (
      `<div class="set-radios" role="radiogroup" aria-labelledby="${lid}" ${desc}>` +
      radio("", L("set.ui.default"), def) +
      eds
        .filter((e) => e.available)
        .map((e) =>
          radio(e.key, e.name, e.terminal ? L("set.ui.terminalTag") : null),
        )
        .join("") +
      "</div>"
    );
  }
  function swatches() {
    const cs = getComputedStyle(document.documentElement);
    return SWATCHES.map((n) => {
      const c = cs.getPropertyValue(`--${n}`).trim();
      return `<div class="sw" style="background:${esc(c)}" title="--${n} ${esc(c)}"><span>${esc(n)}</span></div>`;
    }).join("");
  }

  // ── writing: only on an explicit change ────────────────────────────────
  async function save(r, v) {
    const el = $(`s-${rid(r)}`);
    let ok = false;
    const mine = { v };
    if (PENDING_TYPES.includes(r.control?.type)) pending.set(r.id, mine);
    try {
      ok = (await r.write(v, ctx)) !== false;
    } catch {
      ok = false;
    } finally {
      // A later save of the same row keeps its own.
      if (pending.get(r.id) === mine) pending.delete(r.id);
    }
    redraw();
    const again = $(`s-${rid(r)}`) || el;
    if (!again) return;
    again.className = "set-saved " + (ok ? "ok" : "bad");
    again.textContent = L(ok ? "set.ui.saved" : "set.ui.saveFailed");
    if (ok)
      setTimeout(() => {
        if (again.isConnected) again.textContent = "";
      }, 2000);
  }
  function wireRow(r) {
    if (!r.write && !drawsItself(r)) return;
    const row = $(`setting-${rid(r)}`);
    if (!row) return;
    const t = r.control?.type;
    if (t === "seg" || t === "theme")
      row.querySelectorAll(".seg button").forEach((b) =>
        b.addEventListener("click", () => {
          if (b.getAttribute("aria-pressed") === "true") return;
          save(r, b.dataset.v);
        }),
      );
    else if (t === "radio")
      row
        .querySelectorAll('input[type="radio"]')
        .forEach((i) => i.addEventListener("change", () => save(r, i.value)));
    else if (t === "select" || t === "text")
      row
        .querySelector(".ctl select, .ctl input")
        ?.addEventListener("change", (e) => save(r, e.target.value));
    else if (t === "number")
      row.querySelector(".ctl input")?.addEventListener("change", (e) => {
        const n = Number(e.target.value);
        if (!Number.isFinite(n)) return;
        const c = r.control;
        if ((c.min != null && n < c.min) || (c.max != null && n > c.max)) {
          e.target.reportValidity?.();
          return;
        }
        save(r, n);
      });
    else if (t === "toggle")
      row
        .querySelector(".ctl input")
        ?.addEventListener("change", (e) => save(r, e.target.checked));
    else if (t === "langmap")
      row.querySelectorAll("select[data-lang]").forEach((s) =>
        s.addEventListener("change", () => {
          const map = {};
          row.querySelectorAll("select[data-lang]").forEach((x) => {
            if (x.value) map[x.dataset.lang] = x.value;
          });
          save(r, map);
        }),
      );
    else if (t === "navlist")
      row.addEventListener("click", (e) => {
        const b = e.target.closest("button");
        if (!b || b.disabled) return;
        const cur = value(r) || { hidden: [], order: [] };
        if (b.dataset.hide) {
          const id = b.dataset.hide;
          const hidden = cur.hidden.includes(id)
            ? cur.hidden.filter((x) => x !== id)
            : [...cur.hidden, id];
          save(r, { hidden });
        } else if (b.dataset.move) {
          const ids = shell.orderedNav().map((n) => n.id);
          const i = ids.indexOf(b.dataset.move);
          const j = i + Number(b.dataset.d);
          if (i < 0 || j < 0 || j >= ids.length) return;
          [ids[i], ids[j]] = [ids[j], ids[i]];
          save(r, { order: ids });
        }
      });
    else if (t === "pins")
      row.addEventListener("click", (e) => {
        const b = e.target.closest("button");
        if (!b || b.disabled) return;
        const pins = (value(r) || []).slice();
        if (b.dataset.pinRemove)
          save(
            r,
            pins.filter((p) => p !== b.dataset.pinRemove),
          );
        else if (b.dataset.pinMove) {
          const i = pins.indexOf(b.dataset.pinMove);
          const j = i + Number(b.dataset.d);
          if (i < 0 || j < 0 || j >= pins.length) return;
          [pins[i], pins[j]] = [pins[j], pins[i]];
          save(r, pins);
        }
      });
    else if (t === "workspace-editor")
      // Saves on change, like every other row (SA's dev.20 run: a
      // separate Save gave no sign that a choice was not saved yet).
      row.addEventListener("change", (e) => {
        if (e.target.type === "radio" && e.target.checked)
          save(r, e.target.value);
      });
    else if (t === "custom" && typeof r.control.render === "function") {
      const host = row.querySelector(".set-custom");
      r.control.render(host, ctx, {
        value: value(r),
        save: (v) => save(r, v),
      });
    }
  }
  function rowShown(r) {
    try {
      return typeof r.shown !== "function" || r.shown(ctx) !== false;
    } catch {
      return true;
    }
  }
  return { drawRow, wireRow, value, rowShown, tag };
}

const kits = new WeakMap();
let hosts = 0;
export function drawRows(host, rows, ctx, { idPrefix, scopeTag } = {}) {
  let k = kits.get(host);
  if (!k || k.ctx !== ctx) {
    k = { ctx, rows };
    k.kit = rowKit(ctx, {
      redraw: () => drawRows(host, k.rows, ctx),
      root: host,
      idPrefix: idPrefix ?? `rows${++hosts}-`,
      scopeTag,
    });
    kits.set(host, k);
  }
  k.rows = rows;
  const shown = rows.filter(k.kit.rowShown);
  const keep = document.activeElement?.dataset?.focusKey || null;
  host.innerHTML = shown.map(k.kit.drawRow).join("");
  for (const r of shown) k.kit.wireRow(r);
  if (keep) host.querySelector(`[data-focus-key="${keep}"]`)?.focus();
  return shown.length;
}
