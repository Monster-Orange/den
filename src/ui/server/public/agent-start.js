/**
 * The Start agent form's choices (AG-10.0), shared by the Agents tab's
 * dialog and the Workspaces page's agents section. DOM-free.
 *
 * A persona option shows its id only: its role sentence is the help line
 * under the select (personaHelp), so a long role can't widen the select
 * past the dialog. The runtime's first option names what it resolves to,
 * "Claude Code (persona default)", from the persona picked; a runtime that
 * can't run here says why, and one that can shows its version.
 *
 * AG-0.2, readiness before Start: the line under the runtime names the CLI
 * it will run (its version and path); when that runtime can't run here,
 * Start is disabled and the line says why and how to fix it (install it,
 * or set agents.runtimes.<id>.bin in the user.yml it names, or run
 * `<cli> agents doctor`). Nothing fails only after Start.
 */

function escHtml(s) {
  return String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
}

/** The persona select's options: the id only. */
export function personaOptions(personas) {
  return (personas ?? [])
    .map((p) => `<option value="${escHtml(p.id)}">${escHtml(p.id)}</option>`)
    .join("");
}

/** The help line under the persona select: the picked persona's role. */
export function personaHelp(personas, id) {
  return (personas ?? []).find((p) => p.id === id)?.role ?? "";
}

/** A runtime's name for people ("Claude Code"); its id when it has none. */
export function runtimeName(runtimes, id) {
  const r = (runtimes ?? []).find((x) => x.id === id);
  return r?.label || r?.id || id || "";
}

/**
 * The runtime a persona runs on when the agent names none: the persona's
 * own, else the default runtime.
 */
export function defaultRuntimeOf(personas, runtimes, personaId) {
  const p = (personas ?? []).find((x) => x.id === personaId);
  if (p?.runtime) return p.runtime;
  return (runtimes ?? []).find((r) => r.default)?.id ?? "";
}

/**
 * The runtime select's options. The first ("" = the persona's) reads
 * "<name> (persona default)"; one that can't run here is disabled and
 * says why.
 */
export function runtimeOptions(personas, runtimes, personaId, t) {
  const name = runtimeName(
    runtimes,
    defaultRuntimeOf(personas, runtimes, personaId),
  );
  const first = name ? t("ag.runtime.default", { name }) : t("ag.runtime.auto");
  return (
    `<option value="">${escHtml(first)}</option>` +
    (runtimes ?? [])
      .map((r) => {
        const label = runtimeName(runtimes, r.id);
        return r.available
          ? `<option value="${escHtml(r.id)}">${escHtml(
              r.version ? `${label} · ${r.version}` : label,
            )}</option>`
          : `<option value="${escHtml(r.id)}" disabled>${escHtml(
              `${label} — ${r.why || t("ag.unavailable")}`,
            )}</option>`;
      })
      .join("")
  );
}

/** The most searched directories named inline; the rest are counted. */
const SHOWN_DIRS = 4;

/**
 * Whether Start can run, and the line that says so (AG-0.2): for the
 * runtime picked (`runtimeId`, "" = the persona's), { ok, tone, html }.
 * `tone` is "" (ready), "warn" (can't start) or "none" (nothing to say).
 */
export function readiness(data, personaId, runtimeId, t) {
  const personas = data?.personas ?? [];
  const runtimes = data?.runtimes ?? [];
  const id = runtimeId || defaultRuntimeOf(personas, runtimes, personaId);
  const r = runtimes.find((x) => x.id === id);
  if (!r)
    return {
      ok: false,
      tone: "warn",
      html: escHtml(t("ag.rt.unknown", { id: id || "?" })),
    };
  const name = runtimeName(runtimes, r.id);
  const mono = (x) => `<span class="mono">${escHtml(x)}</span>`;
  if (r.available) {
    if (!r.path) return { ok: true, tone: "none", html: "" };
    return {
      ok: true,
      tone: "",
      html:
        escHtml(
          r.version
            ? t("ag.rt.ready", { name, version: r.version })
            : t("ag.rt.readyNoVer", { name }),
        ) +
        " " +
        mono(r.path),
    };
  }
  const file = data?.userConfig || "config/local/user.yml";
  const fix = t("ag.rt.fix", {
    key: "\u0000k",
    file: "\u0000f",
    cmd: "\u0000c",
  });
  const fixHtml = escHtml(fix)
    .replace("\u0000k", mono(r.setting || `agents.runtimes.${r.id}.bin`))
    .replace("\u0000f", mono(file))
    .replace("\u0000c", mono("__DEN_CLI__ agents doctor"));
  let what;
  if (r.source === "setting" || !r.searched)
    what = escHtml(t("ag.rt.refused", { name, why: r.why || "" }));
  else {
    const dirs = r.searched;
    const shown = dirs.slice(0, SHOWN_DIRS).map(mono).join(", ");
    const more =
      dirs.length > SHOWN_DIRS
        ? " " + escHtml(t("ag.rt.more", { n: dirs.length - SHOWN_DIRS }))
        : "";
    what =
      escHtml(t("ag.rt.notFound", { name })) +
      " " +
      escHtml(t("ag.rt.searched")) +
      " " +
      (shown || escHtml(t("ag.rt.nowhere"))) +
      more +
      ".";
  }
  return { ok: false, tone: "warn", html: `${what} ${fixHtml}` };
}

/**
 * Fill a form's persona and runtime selects, its help line and its
 * readiness line ([data-runtime-ready]), keep them in step when the
 * persona or the runtime changes, and disable its submit button while
 * the runtime can't run. Returns nothing; idempotent per form (the
 * change listeners are bound once).
 */
export function fillStartForm(form, data, t) {
  const personas = data?.personas ?? [];
  const runtimes = data?.runtimes ?? [];
  const ps = form.querySelector('select[name="persona"]');
  const rs = form.querySelector('select[name="runtime"]');
  const help = form.querySelector("[data-persona-help]");
  const ready = form.querySelector("[data-runtime-ready]");
  const go = form.querySelector('button[type="submit"]');
  ps.innerHTML = personaOptions(personas);
  const check = () => {
    const r = readiness(data, ps.value, rs.value, t);
    if (ready) {
      ready.innerHTML = r.html;
      ready.hidden = !r.html;
      ready.dataset.tone = r.tone;
    }
    if (go) {
      go.disabled = !r.ok;
      go.dataset.blocked = r.ok ? "" : "runtime";
    }
  };
  const sync = () => {
    const keep = rs.value;
    rs.innerHTML = runtimeOptions(personas, runtimes, ps.value, t);
    if ([...rs.options].some((o) => o.value === keep && !o.disabled))
      rs.value = keep;
    if (help) {
      const role = personaHelp(personas, ps.value);
      help.textContent = role;
      help.hidden = !role;
    }
    check();
  };
  ps.onchange = sync;
  rs.onchange = check;
  sync();
}

/** Whether a form's Start is held back by its runtime (readiness). */
export function blockedByRuntime(form) {
  return (
    form.querySelector('button[type="submit"]')?.dataset.blocked === "runtime"
  );
}
