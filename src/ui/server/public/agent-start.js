/**
 * The Start agent form's choices (AG-10.0), shared by the Agents tab's
 * dialog and the Workspaces page's agents section. DOM-free.
 *
 * A persona option shows its id only: its role sentence is the help line
 * under the select (personaHelp), so a long role can't widen the select
 * past the dialog. The runtime's first option names what it resolves to,
 * "Claude Code (persona default)", from the persona picked; a runtime that
 * can't run here says why.
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
          ? `<option value="${escHtml(r.id)}">${escHtml(label)}</option>`
          : `<option value="${escHtml(r.id)}" disabled>${escHtml(
              `${label} — ${r.why || t("ag.unavailable")}`,
            )}</option>`;
      })
      .join("")
  );
}

/**
 * Fill a form's persona and runtime selects and its help line, and keep
 * them in step when the persona changes. Returns nothing; idempotent per
 * form (the change listener is bound once).
 */
export function fillStartForm(form, data, t) {
  const personas = data?.personas ?? [];
  const runtimes = data?.runtimes ?? [];
  const ps = form.querySelector('select[name="persona"]');
  const rs = form.querySelector('select[name="runtime"]');
  const help = form.querySelector("[data-persona-help]");
  ps.innerHTML = personaOptions(personas);
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
  };
  ps.onchange = sync;
  sync();
}
