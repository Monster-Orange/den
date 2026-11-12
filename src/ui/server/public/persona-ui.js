/**
 * Personas in the page (AG-10.4 to 10.7, AG-11, AG-12, AG-13): what the
 * Start dialog (agents-page.js) and Settings › Personas share.
 *
 *   - the filter bar (search, category chips, source chips) and the list,
 *     grouped by category when no filter is set (AG-10.4);
 *   - a persona's row: "Rita (reviewer)", its source badge, its one-line
 *     description, and "not installed" when its runtime isn't (AG-12.2);
 *   - Details: its instructions, runtime, model and version, permission
 *     mode, preset and extra commands (AG-10.6);
 *   - the permission block: the mode (AG-13.1), the role's preset as chips
 *     (13.3), extra commands (13.4) and the preview of what the runtime is
 *     given (13.2), from the runtime's own translation (GET /api/personas:
 *     runtimes[].permissions). A runtime that takes none from Den says
 *     "not supported on <runtime>" for each command, never drops one;
 *   - the persona editor (New persona, Edit, Duplicate: AG-10.7), a dialog
 *     of its own, and the Settings › Personas row.
 *
 * Every string a person or a pack wrote is escaped; every write goes to
 * the persona routes (agent-routes.ts), which check every field again.
 */

const t = (key, vars) => window.denShell?.t?.(key, vars) ?? key;
export const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const api = (method, url, body) => window.denShell.api(method, url, body);

/** Den's permission intents (permissions.ts), in the switch's order. */
export const INTENTS = ["ask", "edits", "auto", "all"];
/** The sources a filter offers (hub: later, once Den Hub exists). */
export const ORIGINS = ["builtin", "distribution", "local"];

// The same rule as permissions.ts (the server checks again).
const PREFIX_RE = /^[A-Za-z0-9][A-Za-z0-9 ._/:=@%+,-]*$/;
const PATTERN_RE = /[*?[\]^$(){}|]/;
const MAX_COMMAND_LEN = 120;

/** Den's categories (roles.ts), for an answer that names none. */
const DEN_CATEGORIES = [
  "engineering",
  "design",
  "product",
  "marketing",
  "operations",
].map((id) => ({ id, label: id, source: "den" }));

/**
 * GET /api/personas' answer, filled in where an older or partial one
 * leaves a field out: every persona has a category and a description,
 * and there is a category list.
 */
export function normalizeData(data) {
  // A role that isn't a registry key is an older answer's description.
  const key = (r) => typeof r === "string" && /^[a-z][a-z0-9-]{0,31}$/.test(r);
  const personas = (data?.personas ?? []).map((p) => ({
    ...p,
    role: key(p.role) ? p.role : undefined,
    category: p.category || "engineering",
    description: p.description ?? (key(p.role) ? "" : (p.role ?? "")),
    allowedCommands: p.allowedCommands ?? [],
  }));
  return {
    ...data,
    personas,
    runtimes: data?.runtimes ?? [],
    roles: data?.roles ?? [],
    categories: data?.categories?.length ? data.categories : DEN_CATEGORIES,
  };
}

/** Why `c` isn't a plain prefix ("pattern", "invalid", "long"), or null. */
export function commandProblem(c) {
  if ([...c].length > MAX_COMMAND_LEN) return "long";
  if (PATTERN_RE.test(c)) return "pattern";
  if (!PREFIX_RE.test(c) || /\s{2,}/.test(c) || c !== c.trim())
    return "invalid";
  return null;
}

/** One command per line, trimmed, blank lines dropped, each once. */
export function splitCommands(text) {
  return [
    ...new Set(
      String(text ?? "")
        .split("\n")
        .map((x) => x.trim())
        .filter(Boolean),
    ),
  ];
}

/** A category's label: Den's in the page's language, a distribution's as given. */
export function categoryLabel(categories, id) {
  const c = (categories ?? []).find((x) => x.id === id);
  if (!c) return id ?? "";
  return c.source === "den" ? t(`cat.${c.id}`) : c.label;
}

/** A persona's name as HTML: "Rita <role>(reviewer)</role>", else its id (role). */
export function personaNameHtml(p) {
  if (p.displayName)
    return `${esc(p.displayName)} <span class="role">(${esc(p.role || p.id)})</span>`;
  return `${esc(p.id)}${p.role && p.role !== p.id ? ` <span class="role">(${esc(p.role)})</span>` : ""}`;
}

/** A persona's name as text. */
export function personaName(p) {
  if (!p) return "";
  return p.displayName ? `${p.displayName} (${p.role || p.id})` : p.id;
}

const originOf = (p) => (ORIGINS.includes(p.origin) ? p.origin : "builtin");

/** Its source badge (AG-10.3): built-in, distribution, mine (hub later). */
export function originBadge(p) {
  const o = originOf(p);
  return `<span class="tagx src-${o}" title="${esc(t(`pe.src.${o}.p`))}">${esc(t(`pe.src.${o}`))}</span>`;
}

/** Whether persona `p` matches filter `f` ({ q, cat, src }). */
export function matchPersona(p, f, categories) {
  if (f.cat && p.category !== f.cat) return false;
  if (f.src && originOf(p) !== f.src) return false;
  if (!f.q) return true;
  const hay = [
    p.displayName,
    p.id,
    p.role,
    p.description,
    categoryLabel(categories, p.category),
  ]
    .join(" ")
    .toLowerCase();
  return f.q
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((w) => hay.includes(w));
}

const noFilter = (f) => !f.q && !f.cat && !f.src;

/** The filter bar (AG-10.4): search, then the category and source chips. */
export function filterBarHtml(f, ctx, personas, categories) {
  const chip = (k, v, label, n) =>
    `<button type="button" class="pfc" data-pf="${k}" data-v="${esc(v)}" aria-pressed="${(f[k] || "") === v}">${esc(label)}${n != null ? `<span class="c">${n}</span>` : ""}</button>`;
  // Only the categories some persona is in.
  const cats = (categories ?? []).filter((c) =>
    personas.some((p) => p.category === c.id),
  );
  return (
    `<div class="pfbar"><input type="search" id="${ctx}-q" value="${esc(f.q)}" placeholder="${esc(t("pf.search"))}" aria-label="${esc(t("pf.search"))}" autocomplete="off" spellcheck="false">` +
    `<div class="pfrow" role="group" aria-label="${esc(t("pf.cat"))}"><span class="lab">${esc(t("pf.cat"))}</span>${chip("cat", "", t("pf.all"))}` +
    cats
      .map((c) =>
        chip(
          "cat",
          c.id,
          categoryLabel(categories, c.id),
          personas.filter((p) => p.category === c.id).length,
        ),
      )
      .join("") +
    `</div><div class="pfrow" role="group" aria-label="${esc(t("pf.src"))}"><span class="lab">${esc(t("pf.src"))}</span>${chip("src", "", t("pf.all"))}` +
    ORIGINS.map((o) => chip("src", o, t(`pe.src.${o}`))).join("") +
    `</div></div>`
  );
}

/**
 * The list: grouped under category headings with no filter set, else the
 * matches alone; "No persona matches" when none does.
 */
export function personaListHtml(f, personas, categories, rowFn) {
  const xs = personas.filter((p) => matchPersona(p, f, categories));
  if (!xs.length)
    return `<div class="pempty">${esc(t("pf.none"))} <button type="button" class="lnk" data-x="clear">${esc(t("pf.clear"))}</button></div>`;
  if (!noFilter(f)) return xs.map(rowFn).join("");
  const order = [
    ...(categories ?? []).map((c) => c.id),
    ...new Set(xs.map((p) => p.category)),
  ];
  return [...new Set(order)]
    .filter((id) => xs.some((p) => p.category === id))
    .map((id) => {
      const g = xs.filter((p) => p.category === id);
      return `<div class="pgh"><span>${esc(categoryLabel(categories, id))}</span><span>${g.length}</span></div>${g.map(rowFn).join("")}`;
    })
    .join("");
}

const runtimeOf = (data, id) => (data?.runtimes ?? []).find((r) => r.id === id);
const runtimeLabel = (data, id) => runtimeOf(data, id)?.label || id || "";

/** The runtime a persona runs on (its own, else the default). */
export function personaRuntime(data, p) {
  return p?.runtime || (data?.runtimes ?? []).find((r) => r.default)?.id || "";
}

/** Whether persona `p`'s own runtime is installed here. */
export function runtimeInstalled(data, p) {
  return runtimeOf(data, personaRuntime(data, p))?.available !== false;
}

/** A role's preset (AG-13.3), from the registry. */
export function rolePreset(data, role) {
  return (data?.roles ?? []).find((r) => r.id === role)?.preset ?? [];
}

/** "latest" or a version, for people. */
export function versionLabel(v) {
  return !v || v === "latest" ? t("ver.latest") : v;
}

/** The model a runtime offers by id, or undefined. */
export function modelOf(data, runtime, model) {
  return (runtimeOf(data, runtime)?.models ?? []).find((m) => m.id === model);
}

/** Whether a pinned version is older than its model's newest (AG-12.4). */
export function isStale(data, runtime, model, version) {
  const m = modelOf(data, runtime, model);
  return Boolean(m && version && version !== "latest" && version !== m.latest);
}

const newerBadge = () =>
  `<span class="tagx warn" data-newer title="${esc(t("ver.newerP"))}">${esc(t("ver.newer"))}</span>`;

/** A row of the Start list (a radio). */
export function personaRowHtml(p, checked, data) {
  const missing = !runtimeInstalled(data, p)
    ? ` <span class="tagx warn">${esc(t("rt.notInst", { r: runtimeLabel(data, personaRuntime(data, p)) }))}</span>`
    : "";
  return (
    `<button type="button" class="pr" role="radio" data-pid="${esc(p.id)}" aria-checked="${checked}">` +
    `<span class="rd" aria-hidden="true"></span><span class="pn">${personaNameHtml(p)}${missing}</span>${originBadge(p)}` +
    `<span class="pd">${esc(p.description || "")}</span></button>`
  );
}

/** The permission preview (AG-13.2): what runtime `rt` is given. */
export function permPreviewHtml(data, rtId, intent, preset, extras) {
  const rt = runtimeOf(data, rtId);
  const name = runtimeLabel(data, rtId);
  const perms = rt?.permissions;
  const rule = (c) =>
    perms ? perms.commandRules.map((r) => r.split("{c}").join(c)) : null;
  const line = (c, src) => {
    const why = commandProblem(c);
    const rules = why ? null : rule(c);
    const body = rules
      ? rules.map((r) => `<span class="mono">${esc(r)}</span>`).join(" ")
      : `<span class="mono gone">${esc(c)}</span> <span class="tagx warn">${esc(
          why === "pattern"
            ? t("pe.nsPat")
            : why
              ? t("pe.nsBad")
              : t("pe.ns", { r: name }),
        )}</span>`;
    return `<li data-cmd="${esc(c)}">${body} <span class="src">· ${esc(src)}</span></li>`;
  };
  const mode = perms
    ? `<li><span class="mono">${esc(perms.modes[intent] ?? "")}</span></li>`
    : `<li><span class="tagx warn">${esc(t("pe.nsMode", { r: name }))}</span></li>`;
  return (
    `<div class="pv" data-runtime="${esc(rtId)}"><b>${esc(t("pe.allows", { r: name }))}</b><ul>` +
    mode +
    preset.map((c) => line(c, t("pe.preset").toLowerCase())).join("") +
    extras.map((c) => line(c, t("pe.extraS"))).join("") +
    `</ul></div>`
  );
}

const presetChips = (preset) =>
  preset.length
    ? preset.map((c) => `<span class="pchip">${esc(c)}</span>`).join("")
    : `<span class="faint">—</span>`;

/**
 * The permission block: mode, preset chips, extra commands (collapsed),
 * the preview and the raw config stub (AG-13.5). `s` is
 * { intent, role, extras, runtime, disabled }.
 */
export function permBlockHtml(ctx, data, s) {
  const dis = s.disabled ? " disabled" : "";
  const preset = rolePreset(data, s.role);
  return (
    `<div class="fld"><span>${esc(t("pe.perms"))}</span><div class="seg pmode" role="radiogroup" aria-label="${esc(t("pe.perms"))}">` +
    INTENTS.map(
      (m) =>
        `<button type="button" data-pm="${m}" role="radio" aria-checked="${s.intent === m}" aria-pressed="${s.intent === m}"${dis}>${esc(t(`pm.${m}`))}</button>`,
    ).join("") +
    `</div></div>` +
    `<div class="fld"><span>${esc(t("pe.preset"))} · <span id="${ctx}-presetrole">${esc(s.role || "—")}</span></span><div class="pchips" id="${ctx}-preset">${presetChips(preset)}</div></div>` +
    `<details class="xtra" id="${ctx}-xtra"${s.extrasOpen ? " open" : ""}><summary>${esc(t("pe.extra"))} (<span id="${ctx}-xn">${s.extras.length}</span>)</summary>` +
    `<textarea id="${ctx}-tools" rows="3" spellcheck="false" aria-label="${esc(t("pe.extra"))}"${dis}>${esc(s.extras.join("\n"))}</textarea><small class="faint">${esc(t("pe.extraP"))}</small></details>` +
    `<div class="pvw" id="${ctx}-pv">${permPreviewHtml(data, s.runtime, s.intent, preset, s.extras)}</div>` +
    `<div class="helpl"><button type="button" class="lnk" data-x="raw" aria-disabled="true" title="${esc(t("pe.rawLater"))}">${esc(t("pe.raw"))}</button> <span class="tagx warn">${esc(t("pe.vendor"))}</span> <span class="tagx">${esc(t("rt.later"))}</span></div>`
  );
}

/** Keep a permission block's preview, count and preset in step. */
export function syncPermBlock(root, ctx, data, s) {
  const preset = rolePreset(data, s.role);
  const pv = root.querySelector(`#${ctx}-pv`);
  if (pv)
    pv.innerHTML = permPreviewHtml(data, s.runtime, s.intent, preset, s.extras);
  const xn = root.querySelector(`#${ctx}-xn`);
  if (xn) xn.textContent = String(s.extras.length);
  const pr = root.querySelector(`#${ctx}-preset`);
  if (pr) pr.innerHTML = presetChips(preset);
  const rl = root.querySelector(`#${ctx}-presetrole`);
  if (rl) rl.textContent = s.role || "—";
  for (const b of root.querySelectorAll("[data-pm]")) {
    b.setAttribute("aria-pressed", String(b.dataset.pm === s.intent));
    b.setAttribute("aria-checked", String(b.dataset.pm === s.intent));
  }
}

/** Model options for runtime `rt`: "" first (labelled `first`), then its models. */
export function modelOptionsHtml(data, rt, cur, first) {
  const ms = runtimeOf(data, rt)?.models ?? [];
  return (
    `<option value="">${esc(first)}</option>` +
    ms
      .map(
        (m) =>
          `<option value="${esc(m.id)}"${m.id === cur ? " selected" : ""}>${esc(m.label || m.id)}</option>`,
      )
      .join("")
  );
}

/** Version options for a model: "" (labelled `first`) when given, Latest, then each. */
export function versionOptionsHtml(data, rt, model, cur, first) {
  const m = modelOf(data, rt, model);
  const opts = [
    ...(first != null ? [["", first]] : []),
    ["latest", t("ver.latestP")],
    ...(m?.versions ?? []).map((v) => [v, v]),
  ];
  return opts
    .map(
      ([v, l]) =>
        `<option value="${esc(v)}"${v === cur ? " selected" : ""}>${esc(l)}</option>`,
    )
    .join("");
}

/** Details (AG-10.6): `p` with its instructions (GET /api/personas/<id>). */
export function personaDetailHtml(p, data) {
  const rt = personaRuntime(data, p);
  const intent = p.permission || "ask";
  const preset = rolePreset(data, p.role);
  const extras = p.allowedCommands ?? [];
  const list = (xs) =>
    xs.length
      ? xs.map((x) => `<span class="mono">${esc(x)}</span>`).join(" · ")
      : esc(t("pe.noneCmd"));
  return (
    `<div class="pdet" id="ag-det"><div class="why">${originBadge(p)} ${esc(t(`pe.src.${originOf(p)}.p`))}</div>` +
    `<div><span class="k">${esc(t("pe.instr"))}</span><pre>${p.instructions == null ? esc(t("pe.loading")) : esc(p.instructions)}</pre></div>` +
    `<div><span class="k">${esc(t("pe.runtime"))}</span> <span class="mono">${esc(runtimeLabel(data, rt))}</span> · <span class="k">${esc(t("pe.model"))}</span> <span class="mono">${esc(p.model || t("pe.rtDefault"))} · ${esc(versionLabel(p.version))}</span>${isStale(data, rt, p.model, p.version) ? ` ${newerBadge()}` : ""}</div>` +
    `<div><span class="k">${esc(t("pe.perms"))}</span> ${esc(t(`pm.${intent}`))}</div>` +
    `<div><span class="k">${esc(t("pe.preset"))}</span> ${list(preset)}</div>` +
    `<div><span class="k">${esc(t("pe.extra"))}</span> ${list(extras)}</div>` +
    `<div class="pvw">${permPreviewHtml(data, rt, intent, preset, extras)}</div></div>`
  );
}

const detailAsked = new Map();
/** A persona with its instructions, asked once per page. */
export function personaDetail(id) {
  if (!detailAsked.has(id))
    detailAsked.set(
      id,
      api("GET", `/api/personas/${encodeURIComponent(id)}`)
        .then((r) => r.persona)
        .catch((e) => {
          detailAsked.delete(id);
          throw e;
        }),
    );
  return detailAsked.get(id);
}
/** Forget what was asked (after a save or delete). */
export function forgetPersonaDetails() {
  detailAsked.clear();
}

/**
 * The tags a session's row carries (AG-10.9, AG-12.4, AG-13.1): what it
 * overrides of its persona, Auto-approve all always, and "newer available"
 * when it is pinned to an older version. HTML.
 */
export function overrideTagsHtml(r) {
  const ov = r.overrides ?? [];
  const tags = [];
  if (ov.includes("runtime") && r.runtime)
    tags.push(["", t("ov.runtime", { r: r.runtime }), "runtime"]);
  if (ov.includes("model") && r.model)
    tags.push(["", t("ov.model", { m: r.model }), "model"]);
  if (ov.includes("version") && r.version)
    tags.push([
      "",
      r.version === "latest"
        ? t("ov.latest")
        : t("ver.pinned", { v: r.version }),
      "version",
    ]);
  if (r.permission === "all")
    tags.push(["warn", t("pm.tag.all"), "permission"]);
  // den#48: auto mode always shows: its peers' mode, not the persona's.
  else if (r.permission === "auto")
    tags.push(["", t("pm.tag.auto"), "permission"]);
  else if (ov.includes("permission") && r.permission)
    tags.push([
      r.permission === "ask" ? "" : "warn",
      t(`pm.tag.${r.permission}`),
      "permission",
    ]);
  if (ov.includes("allow")) tags.push(["", t("ov.tools"), "allow"]);
  if (r.newer) tags.push(["warn", t("ver.newer"), "newer"]);
  return tags
    .map(
      ([cls, label, k]) =>
        `<span class="tagx${cls ? ` ${cls}` : ""}" data-ov="${k}"${k === "newer" ? ` title="${esc(t("ver.newerOf", { v: r.newer }))}"` : ""}>${esc(label)}</span>`,
    )
    .join("");
}

// ── The persona editor (AG-10.7) ─────────────────────────────────────────

/** The fields the editor sends (persona-store.ts KEYS). */
function editorBody(dlg, s) {
  const v = (sel) => dlg.querySelector(sel)?.value ?? "";
  return {
    displayName: v("#pe-name").trim(),
    role: v("#pe-role"),
    category: v("#pe-cat"),
    description: v("#pe-desc").trim(),
    instructions: v("#pe-instr"),
    runtime: v("#pe-rt"),
    model: v("#pe-model"),
    version: v("#pe-ver") || "latest",
    permission: s.intent,
    allowedCommands: splitCommands(v("#pe-tools")),
  };
}

function runtimeOptionsHtml(data, cur) {
  const rts = (data?.runtimes ?? []).filter((r) => r.id !== "generic");
  const opt = (r) =>
    `<option value="${esc(r.id)}"${r.id === cur ? " selected" : ""}>${esc(r.label || r.id)}${r.available ? (r.version ? ` · ${esc(r.version)}` : "") : ` · ${esc(t("rt.missing"))}`}</option>`;
  const ins = rts.filter((r) => r.available);
  const out = rts.filter((r) => !r.available);
  return (
    `<optgroup label="${esc(t("rt.installed"))}">${ins.map(opt).join("")}</optgroup>` +
    (out.length
      ? `<optgroup label="${esc(t("rt.missing"))}">${out.map(opt).join("")}</optgroup>`
      : "")
  );
}

/**
 * Open the persona editor. `o`: { data (GET /api/personas), src (a
 * persona with instructions, to edit or duplicate; none: New), dup,
 * view (read-only), onSaved(persona), onClosed() }. A persona that isn't
 * local opens as View, with Duplicate.
 */
export function openPersonaEditor(o) {
  const data = o.data;
  const src = o.src ?? null;
  const ro = Boolean(src && !o.dup && src.origin !== "local");
  const isNew = !src || o.dup;
  const roles = data?.roles ?? [];
  const firstRole = roles.find((r) => r.id === "sde") ?? roles[0];
  const d = src
    ? {
        displayName: o.dup
          ? t("pe.copy", { n: src.displayName || src.id })
          : src.displayName || "",
        role: src.role || firstRole?.id || "",
        category: src.category || "engineering",
        description: src.description || "",
        instructions: src.instructions || "",
        runtime: src.runtime || personaRuntime(data, src),
        model: src.model || "",
        version: src.version || "latest",
        permission: src.permission || "ask",
        allowedCommands: [...(src.allowedCommands ?? [])],
      }
    : {
        displayName: "",
        role: firstRole?.id || "",
        category: firstRole?.category || "engineering",
        description: "",
        instructions: "",
        runtime: personaRuntime(data, null),
        model: "",
        version: "latest",
        permission: firstRole?.mode || "ask",
        allowedCommands: [],
      };
  const s = {
    intent: d.permission,
    role: d.role,
    runtime: d.runtime,
    extras: d.allowedCommands,
  };
  const dis = ro ? " disabled" : "";
  const title = ro
    ? personaName(src)
    : isNew
      ? t(o.dup ? "pe.dupT" : "pe.new")
      : t("pe.edit");
  const dlg = document.createElement("dialog");
  dlg.className = "ag-dlg pe-dlg";
  dlg.id = "pe-dlg";
  dlg.setAttribute("aria-labelledby", "pe-h");
  const cats = data?.categories ?? [];
  dlg.innerHTML =
    `<form method="dialog" id="pe-form" novalidate>` +
    `<h2 id="pe-h">${esc(title)}</h2>` +
    (ro ? `<p class="help">${originBadge(src)} ${esc(t("pe.ro"))}</p>` : "") +
    `<div class="two"><label class="fld"><span>${esc(t("pe.name"))}</span><input type="text" id="pe-name" maxlength="40" value="${esc(d.displayName)}" placeholder="${esc(t("pe.nameP"))}"${dis}></label>` +
    `<label class="fld"><span>${esc(t("pe.role"))}</span><select id="pe-role"${dis}>${roles.map((r) => `<option value="${esc(r.id)}"${r.id === d.role ? " selected" : ""}>${esc(r.id)}</option>`).join("")}</select></label></div>` +
    `<div class="helpl">${esc(t("pe.roleHelp"))}</div>` +
    `<div class="two"><label class="fld"><span>${esc(t("pe.cat"))}</span><select id="pe-cat"${dis}>${cats.map((c) => `<option value="${esc(c.id)}"${c.id === d.category ? " selected" : ""}>${esc(categoryLabel(cats, c.id))}</option>`).join("")}</select></label>` +
    `<label class="fld"><span>${esc(t("pe.desc"))}</span><input type="text" id="pe-desc" maxlength="200" value="${esc(d.description)}"${dis}></label></div>` +
    `<label class="fld"><span>${esc(t("pe.instr"))}</span><textarea id="pe-instr" rows="5" spellcheck="true"${dis}>${esc(d.instructions)}</textarea></label>` +
    `<div class="two"><label class="fld"><span>${esc(t("pe.runtime"))}</span><select id="pe-rt"${dis}>${runtimeOptionsHtml(data, d.runtime)}</select></label>` +
    `<label class="fld"><span>${esc(t("pe.model"))}</span><select id="pe-model"${dis}>${modelOptionsHtml(data, d.runtime, d.model, t("pe.rtDefault"))}</select></label></div>` +
    `<div class="two"><label class="fld"><span>${esc(t("pe.ver"))}</span><select id="pe-ver"${dis}>${versionOptionsHtml(data, d.runtime, d.model, d.version)}</select></label><span class="helpl" id="pe-newer">${isStale(data, d.runtime, d.model, d.version) ? `${newerBadge()} <button type="button" class="lnk" data-x="latest">${esc(t("ver.use"))}</button>` : ""}</span></div>` +
    `<div class="pblk">${permBlockHtml("pe", data, { ...s, disabled: ro, extrasOpen: s.extras.length > 0 })}</div>` +
    `<p class="err" id="pe-err" role="alert" hidden></p>` +
    `<div class="btns">${!isNew && src.origin === "local" ? `<button type="button" class="den-btn" data-x="del">${esc(t("pe.del"))}</button>` : ""}<span class="sp"></span>` +
    `<button type="button" class="den-btn" data-x="cancel">${esc(t("ag.cancel"))}</button>` +
    (ro
      ? `<button type="button" class="den-btn primary" data-x="dup">${esc(t("pe.dup"))}</button>`
      : `<button type="submit" class="den-btn primary" id="pe-go">${esc(t("pe.save"))}</button>`) +
    `</div></form>`;
  document.body.append(dlg);
  const $ = (sel) => dlg.querySelector(sel);
  const close = () => {
    dlg.close?.();
    dlg.remove();
    o.onClosed?.();
  };
  dlg.addEventListener("cancel", (e) => {
    e.preventDefault();
    close();
  });
  const sync = () => {
    s.extras = splitCommands($("#pe-tools").value);
    s.role = $("#pe-role").value;
    s.runtime = $("#pe-rt").value;
    syncPermBlock(dlg, "pe", data, s);
  };
  // A role fills a new persona in from its template, never over what is
  // already typed (AG-11.2).
  const prev = { instr: d.instructions, intent: s.intent, cat: d.category };
  const prefill = () => {
    if (!isNew || o.dup) return;
    const r = roles.find((x) => x.id === $("#pe-role").value);
    if (!r) return;
    const ti = $("#pe-instr");
    if (ti.value === prev.instr) ti.value = prev.instr = r.instructions || "";
    if (s.intent === prev.intent) s.intent = prev.intent = r.mode || "ask";
    const cs = $("#pe-cat");
    if (cs.value === prev.cat && r.category) cs.value = prev.cat = r.category;
  };
  if (isNew && !o.dup) prefill();
  sync();
  $("#pe-role").addEventListener("change", () => {
    prefill();
    sync();
  });
  $("#pe-tools").addEventListener("input", sync);
  const newer = () => {
    $("#pe-newer").innerHTML = isStale(
      data,
      $("#pe-rt").value,
      $("#pe-model").value,
      $("#pe-ver").value,
    )
      ? `${newerBadge()} <button type="button" class="lnk" data-x="latest">${esc(t("ver.use"))}</button>`
      : "";
  };
  $("#pe-rt").addEventListener("change", () => {
    $("#pe-model").innerHTML = modelOptionsHtml(
      data,
      $("#pe-rt").value,
      "",
      t("pe.rtDefault"),
    );
    $("#pe-ver").innerHTML = versionOptionsHtml(
      data,
      $("#pe-rt").value,
      "",
      "latest",
    );
    sync();
    newer();
  });
  $("#pe-model").addEventListener("change", () => {
    $("#pe-ver").innerHTML = versionOptionsHtml(
      data,
      $("#pe-rt").value,
      $("#pe-model").value,
      "latest",
    );
    newer();
  });
  $("#pe-ver").addEventListener("change", newer);
  dlg.addEventListener("click", async (e) => {
    const pm = e.target.closest("[data-pm]");
    if (pm && !pm.disabled) {
      e.preventDefault();
      s.intent = pm.dataset.pm;
      sync();
      return;
    }
    const b = e.target.closest("[data-x]");
    if (!b) return;
    const x = b.dataset.x;
    if (x === "cancel") close();
    else if (x === "raw") window.denShell?.toast?.(t("pe.rawLater"));
    else if (x === "latest") {
      $("#pe-ver").value = "latest";
      newer();
    } else if (x === "dup") {
      close();
      openPersonaEditor({ ...o, dup: true });
    } else if (x === "del") {
      try {
        await api("DELETE", `/api/personas/${encodeURIComponent(src.id)}`);
        forgetPersonaDetails();
        window.denShell?.toast?.(t("pe.deleted", { n: personaName(src) }));
        dlg.close?.();
        dlg.remove();
        await o.onSaved?.(null);
      } catch (err) {
        showErr(err);
      }
    }
  });
  const showErr = (err) => {
    const el = $("#pe-err");
    el.textContent = err?.message || String(err);
    el.hidden = false;
  };
  $("#pe-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (ro) return;
    const body = editorBody(dlg, s);
    const bad = body.allowedCommands.find((c) => commandProblem(c));
    if (bad) return showErr(new Error(t("pe.badCmd", { c: bad })));
    const go = $("#pe-go");
    go.disabled = true;
    try {
      const r = isNew
        ? await api("POST", "/api/personas", body)
        : await api(
            "POST",
            `/api/personas/${encodeURIComponent(src.id)}`,
            body,
          );
      forgetPersonaDetails();
      window.denShell?.toast?.(t("pe.saved", { n: personaName(r.persona) }));
      dlg.close?.();
      dlg.remove();
      await o.onSaved?.(r.persona);
    } catch (err) {
      showErr(err);
    } finally {
      go.disabled = false;
    }
  });
  if (typeof dlg.showModal === "function") dlg.showModal();
  else dlg.setAttribute("open", "");
  (ro ? $('[data-x="dup"]') : $("#pe-name"))?.focus();
  return dlg;
}

// ── Settings › Personas (AG-10.7) ────────────────────────────────────────

/**
 * The Settings › Personas row: the filter bar, the list (View or Edit,
 * Duplicate, Delete for your own), "+ New persona", and "newer
 * available" on one pinned to an older version (AG-12.4).
 */
export function renderPersonasSettings(host, ctx) {
  const f = { q: "", cat: "", src: "" };
  let data = null;
  const row = (p) => {
    const mine = p.origin === "local";
    const rt = personaRuntime(data, p);
    const stale = isStale(data, rt, p.model, p.version);
    return (
      `<div class="prow" data-pid="${esc(p.id)}"><div class="pn">${personaNameHtml(p)} ${originBadge(p)}${stale ? ` ${newerBadge()}${mine ? ` <button type="button" class="lnk" data-x="latest">${esc(t("ver.use"))}</button>` : ""}` : ""}</div>` +
      `<div class="pd">${esc(p.description || "")}</div>` +
      `<div class="pm"><span class="mono">${esc(runtimeLabel(data, rt))}${p.model ? ` · ${esc(p.model)} · ${esc(versionLabel(p.version))}` : ""}</span> · ${esc(t(`pm.${p.permission || "ask"}`))}</div>` +
      `<div class="pa"><button type="button" class="den-btn sm" data-x="${mine ? "edit" : "view"}">${esc(t(mine ? "pe.editB" : "pe.view"))}</button>` +
      `<button type="button" class="den-btn sm" data-x="dup">${esc(t("pe.dup"))}</button>` +
      (mine
        ? `<button type="button" class="den-btn sm" data-x="del">${esc(t("pe.del"))}</button>`
        : "") +
      `</div></div>`
    );
  };
  const drawList = () => {
    const l = host.querySelector(".plist");
    if (l)
      l.innerHTML = personaListHtml(f, data.personas, data.categories, row);
  };
  const draw = () => {
    host.innerHTML =
      `<div class="pe-set"><div class="fldh"><span class="helpl">${esc(t("pe.what"))}</span><span class="sp"></span><button type="button" class="den-btn sm" data-x="new">${esc(t("ag.new.newP"))}</button></div>` +
      filterBarHtml(f, "set", data.personas, data.categories) +
      `<div class="plist" role="list" aria-label="${esc(t("set.agents.personas"))}"></div></div>`;
    drawList();
  };
  const load = async () => {
    // Under an invalid config the personas answer 422: say why, ask nothing.
    if ((ctx?.shell ?? window.denShell)?.configInvalid?.() === true) {
      host.innerHTML = `<div class="set-note">${esc(t("pe.configFirst"))}</div>`;
      return;
    }
    try {
      data = normalizeData(await api("GET", "/api/personas"));
      draw();
    } catch (e) {
      host.innerHTML = `<div class="set-note">${esc(e?.message || t("pe.loadFail"))}</div>`;
    }
  };
  host.addEventListener("input", (e) => {
    if (e.target.id !== "set-q") return;
    f.q = e.target.value;
    drawList();
  });
  host.addEventListener("click", async (e) => {
    const chip = e.target.closest("[data-pf]");
    if (chip) {
      f[chip.dataset.pf] = chip.dataset.v;
      for (const c of host.querySelectorAll(`[data-pf="${chip.dataset.pf}"]`))
        c.setAttribute("aria-pressed", String(c.dataset.v === chip.dataset.v));
      return drawList();
    }
    const b = e.target.closest("[data-x]");
    if (!b) return;
    const x = b.dataset.x;
    const reload = async () => {
      forgetPersonaDetails();
      await load();
    };
    if (x === "clear") {
      f.q = f.cat = f.src = "";
      return draw();
    }
    if (x === "new") return void openPersonaEditor({ data, onSaved: reload });
    const id = b.closest("[data-pid]")?.dataset.pid;
    if (!id) return;
    try {
      const p = await personaDetail(id);
      if (x === "del") {
        await api("DELETE", `/api/personas/${encodeURIComponent(id)}`);
        window.denShell?.toast?.(t("pe.deleted", { n: personaName(p) }));
        return void reload();
      }
      if (x === "latest") {
        await api("POST", `/api/personas/${encodeURIComponent(id)}`, {
          displayName: p.displayName || "",
          role: p.role,
          category: p.category,
          description: p.description,
          instructions: p.instructions,
          runtime: personaRuntime(data, p),
          model: p.model || "",
          version: "latest",
          permission: p.permission || "ask",
          allowedCommands: p.allowedCommands ?? [],
        });
        window.denShell?.toast?.(t("ver.usedLatest", { n: personaName(p) }));
        return void reload();
      }
      openPersonaEditor({ data, src: p, dup: x === "dup", onSaved: reload });
    } catch (err) {
      window.denShell?.errorToast?.(err);
    }
  });
  void load();
}
