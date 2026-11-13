/**
 * One rule for org and workspace on a page (0.4.17, ORG-SPEC §5): a page
 * shows its own org picker only when it filters by org. Otherwise it
 * follows the top bar's View (Org and Workspace ▾), and says so with the
 * same note. Environments and Releases both use this.
 *
 *   viewScope()            → { scope: "all" | <workspace>, inView: [names] }
 *   viewNoteHtml(view)     → the "Follows the top bar" note's HTML
 *   viewQuery(view)        → "&workspace=<ws>" for one workspace, else ""
 *   viewRepos(view)        → the repos in view (a Set), or null for all
 */

const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[c],
  );

/** The top bar's View: all active projects, or one. */
export async function viewScope() {
  const v = await fetch("/api/scope", { headers: { accept: "json" } })
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);
  return {
    scope: typeof v?.scope === "string" && v.scope ? v.scope : "all",
    inView: Array.isArray(v?.inView) ? v.inView : [],
  };
}

/** The same note on every page that follows the View. */
export function viewNoteHtml(view) {
  const what =
    view.scope === "all"
      ? "all active projects"
      : `project <b>${esc(view.scope)}</b>`;
  return `<span class="note view-note" data-view="${esc(view.scope)}">Shows ${what}, as the top bar's View. Change it there.</span>`;
}

/** The health and services query for the View: one workspace, or none. */
export function viewQuery(view) {
  return view.scope === "all"
    ? ""
    : `&workspace=${encodeURIComponent(view.scope)}`;
}

/** The repos in the View's workspace, or null when it is all active. */
export async function viewRepos(view) {
  if (view.scope === "all") return null;
  const d = await fetch("/api/workspaces", { headers: { accept: "json" } })
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);
  const ws = d?.workspaces?.[view.scope];
  return ws ? new Set(Object.keys(ws.services ?? {})) : null;
}
