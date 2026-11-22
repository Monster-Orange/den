/**
 * Issue 168 (mock v2): choosing a project's colour. The eight colours and
 * Automatic, in the kit's dialog; the same control in Manage projects and
 * in Settings › Project setup. The choice is the person's own (user
 * settings, shell.projectColours), like the project order: never shared,
 * never sent to Hub.
 *
 *   colourChoiceHtml(opts, t)   the choice's HTML (pure, unit-tested)
 *   colourDotHtml(data, slug, name, t)
 *                               a project's dot, a button that opens it
 *   pickProjectColour(opts)     opens it; resolves true once saved
 */
import {
  PROJECT_COLOURS,
  PROJECT_COLOURS_KEY,
  projectColour,
} from "./workspace-picker.js";
import { dialogHtml, mountDialog } from "./dialog-den.js";

const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );

/** The colour this person chose for `slug`, or "" (Automatic). */
export function chosenColour(data, slug) {
  const c = data?.projectColours?.[slug];
  return PROJECT_COLOURS.includes(c) ? c : "";
}

/** What Automatic gives `slug` now: its colour with the choice taken away. */
export function automaticColour(data, slug) {
  const rest = { ...(data?.projectColours ?? {}) };
  delete rest[slug];
  return projectColour({ ...data, projectColours: rest }, slug);
}

/**
 * The choice: Automatic (with the colour it gives now) and the eight,
 * each a radio with its name beside its swatch (never colour alone).
 */
export function colourChoiceHtml({ slug, chosen, auto }, t) {
  const opt = (value, colour, label) =>
    `<label class="pcp-o"><input type="radio" name="pcp-${esc(slug)}" value="${esc(value)}"${value === chosen ? " checked" : ""}>` +
    `<span class="pcp-sw${value ? "" : " auto"}" data-pc="${esc(colour)}" aria-hidden="true"></span>` +
    `<span class="pcp-l">${esc(label)}</span></label>`;
  return (
    `<fieldset class="pcp" data-pcp="${esc(slug)}"><legend class="den-sr">${esc(t("pc.change"))}</legend>` +
    opt("", auto ?? "", t("pc.autoIs", { colour: t(`pc.${auto}`) })) +
    PROJECT_COLOURS.map((c) => opt(c, c, t(`pc.${c}`))).join("") +
    `</fieldset>`
  );
}

/** A project's colour dot as a button: its name and colour in its label. */
export function colourDotHtml(data, slug, name, t) {
  const c = projectColour(data, slug);
  if (!c) return "";
  return `<button type="button" class="pcp-dot" data-pc-pick="${esc(slug)}" data-pc="${esc(c)}" title="${esc(t("pc.changeFor", { name }))}" aria-label="${esc(`${t("pc.changeFor", { name })}: ${t(`pc.${c}`)}`)}"><span class="den-pc" aria-hidden="true"></span></button>`;
}

const PCP_CSS = [
  ".pcp { display: flex; flex-wrap: wrap; gap: 8px; border: 0; padding: 0; margin: 8px 0 0; }",
  ".pcp-o { display: flex; flex-direction: column; align-items: center; gap: 4px; width: 72px;",
  "  font-size: 12px; color: var(--muted); cursor: pointer; text-align: center; position: relative; }",
  ".pcp-o input { position: absolute; opacity: 0; pointer-events: none; }",
  ".pcp-sw { width: 32px; height: 32px; border-radius: 50%; background: var(--pc, var(--faint)); display: block; }",
  ".pcp-sw.auto { box-shadow: inset 0 0 0 3px var(--surface); border: 2px dashed var(--muted); }",
  ".pcp-o input:checked + .pcp-sw { outline: 2px solid var(--text); outline-offset: 2px; }",
  ".pcp-o input:checked ~ .pcp-l { color: var(--text); font-weight: 600; }",
  ".pcp-o input:focus-visible + .pcp-sw { outline: 2px solid var(--accent-text); outline-offset: 2px; }",
  ".pcp-dot { display: inline-flex; align-items: center; justify-content: center; min-width: 28px;",
  "  min-height: 28px; padding: 0; border: 0; background: none; cursor: pointer; border-radius: 50%; }",
  ".pcp-dot .den-pc { margin: 0; width: 12px; height: 12px; }",
  ".pcp-dot:hover .den-pc, .pcp-dot:focus-visible .den-pc { outline: 2px solid var(--text); outline-offset: 2px; }",
].join("\n");

function ensureCss() {
  if (document.getElementById("pcp-css")) return;
  const s = document.createElement("style");
  s.id = "pcp-css";
  s.textContent = PCP_CSS;
  document.head.append(s);
}

/**
 * Opens the choice for `slug` (shown as `name`) over `opener`. Saves with
 * POST /api/settings; resolves true once saved, false when cancelled or
 * refused (a refusal is said in the dialog's place, as a toast).
 */
export async function pickProjectColour({ slug, name, data, opener }) {
  ensureCss();
  const sh = window.denShell;
  const t = (k, v) => sh?.t?.(k, v) ?? k;
  const chosen = chosenColour(data, slug);
  const auto = automaticColour(data, slug);
  const frame = mountDialog(
    dialogHtml({
      kind: "confirm",
      id: "pcp-dlg",
      ids: { h: "pcp-h", m: "pcp-m" },
      title: t("pc.title", { name }),
      body: esc(t("pc.help")),
      extra: colourChoiceHtml({ slug, chosen, auto }, t),
      actions: [
        { label: t("dlg.cancel"), value: "cancel" },
        { label: t("pc.save"), value: "save", kind: "primary" },
      ],
    }),
    { opener, focus: "input:checked" },
  );
  const value = await frame.closed;
  if (value !== "save") return false;
  const picked =
    frame.dialog.querySelector(`input[name="pcp-${CSS.escape(slug)}"]:checked`)
      ?.value ?? chosen;
  if (picked === chosen) return false;
  try {
    const r = await sh.api("POST", "/api/settings", {
      shell: { projectColours: { [slug]: picked || null } },
    });
    if (r && r.ok === false) throw new Error(r.error || "refused");
  } catch (e) {
    sh?.toast?.(t("pc.failed", { err: e?.message || String(e) }));
    return false;
  }
  if (data) {
    const next = { ...(data.projectColours ?? {}) };
    if (picked) next[slug] = picked;
    else delete next[slug];
    data.projectColours = next;
  }
  try {
    window.dispatchEvent(
      new CustomEvent("den:project-colours", { detail: { slug, picked } }),
    );
  } catch {
    /* no CustomEvent */
  }
  // The person's other tabs: their storage event repaints them.
  try {
    localStorage.setItem(PROJECT_COLOURS_KEY, String(Date.now()));
  } catch {
    /* no storage: they show it at their next load */
  }
  return true;
}
