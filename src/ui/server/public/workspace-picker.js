/**
 * The Workspace ▾ menu's model.
 *
 * Pure and DOM-free (like perf-report.js) so the shape of the header's
 * Workspace menu is unit-testable under Jest's node environment; header.js
 * owns everything that touches the DOM.
 *
 * Input is always the `/api/workspaces` payload:
 *   { workspaces: { [name]: config }, active: string[] | string, focus?: string }
 * `active` is an array since multi-active workspaces; older payloads sent a
 * single string, which both helpers still accept.
 */

/**
 * The menu's en strings, for where there is no shell (a unit test). In a
 * page, header.js passes the shell's t (R19), which has the same en text
 * (i18n.test.ts holds them equal).
 */
export const EN_FALLBACK = {
  "ws.all": "All active",
  "ws.allN": "All active ({n})",
  "ws.allTip": "Every active project; a service several define is listed once",
  "ws.noneLabel": "none",
  "ws.viewTitle":
    "View: what every page shows ({ws}). A view filter only: it starts, stops and routes nothing.",
  "ws.viewTitleFocus":
    "View: what every page shows ({ws}). It starts, stops and routes nothing. CLI default: {focus}.",
  "ws.pickTip":
    "Picking a project here also makes it the CLI default, so __DEN_CLI__ commands run there.",
};
function enT(key, vars) {
  return String(EN_FALLBACK[key] ?? key).replace(/\{(\w+)\}/g, (m, k) =>
    vars && vars[k] != null ? String(vars[k]) : m,
  );
}

/** Active workspace names, normalised to an array. */
function activeNames(data) {
  const active = data?.active;
  if (Array.isArray(active)) return active.filter(Boolean);
  return active ? [active] : [];
}

/** Focused workspace name: explicit focus → first active → null. */
function focusName(data) {
  const active = activeNames(data);
  if (data?.focus) return data.focus;
  return active[0] ?? null;
}

/**
 * The top bar's Workspace ▾ menu (R4, 0.3.0-dev.18), from the `/api/scope`
 * and `/api/workspaces` payloads. It is the view scope: what every page,
 * the health row and `status` show. Choosing a workspace also makes it the
 * focus (the CLI default, Ward's decision in 0.4.11); "All active" leaves
 * the focus where it is. The focused workspace is marked, and `focus`
 * names it, so the caller can skip a choice that is already the focus.
 *
 * "All active" is offered with two or more active workspaces; with one,
 * it and that workspace are the same view.
 */
/** D70: a workspace's name as the person typed it, else its slug. */
export function wsLabel(data, slug) {
  const n = data?.workspaces?.[slug]?.name;
  return typeof n === "string" && n.trim() ? n.trim() : slug;
}

/**
 * 0.4.45 (LOGICAL-ERD): the name a project shows. Hub's when it is linked
 * to a Hub project, else its own (wsLabel). The server's twin is
 * projectDisplayName in src/shared/workspace-name.ts.
 */
export function projectLabel(data, slug) {
  const h = data?.workspaces?.[slug]?.hub_project?.name;
  return typeof h === "string" && h.trim() ? h.trim() : wsLabel(data, slug);
}

/** Where that name comes from: "hub" or "local". */
export function projectNameSource(data, slug) {
  const h = data?.workspaces?.[slug]?.hub_project?.name;
  return typeof h === "string" && h.trim() ? "hub" : "local";
}

/**
 * Projects in this person's order (0.4.45): A to Z by the name shown,
 * ignoring case and accents, in the page's language; with a saved order,
 * that order, and a project not in it slots in A to Z: before the first
 * saved project whose name sorts after its own.
 */
export function orderProjects(slugs, data, saved = [], locale) {
  let coll;
  try {
    coll = new Intl.Collator(locale || undefined, { sensitivity: "base" });
  } catch {
    coll = new Intl.Collator(undefined, { sensitivity: "base" });
  }
  const by = (a, b) =>
    coll.compare(projectLabel(data, a), projectLabel(data, b)) ||
    (a < b ? -1 : a > b ? 1 : 0);
  const az = [...new Set(slugs)].sort(by);
  const keep = Array.isArray(saved) ? saved.filter((s) => az.includes(s)) : [];
  const out = [...new Set(keep)];
  for (const s of az) {
    if (out.includes(s)) continue;
    const at = out.findIndex((o) => by(o, s) > 0);
    if (at < 0) out.push(s);
    else out.splice(at, 0, s);
  }
  return out;
}

/**
 * Manage projects' Move up / Move down (`by` -1 or 1) and drop
 * (`{ before: slug | null }`, null for last). A new list; the ends and an
 * unknown slug leave it as it was.
 */
export function moveProject(list, slug, by) {
  const out = [...list];
  const i = out.indexOf(slug);
  if (i < 0) return out;
  if (typeof by === "number") {
    const j = i + by;
    if (j < 0 || j >= out.length) return out;
    [out[i], out[j]] = [out[j], out[i]];
    return out;
  }
  out.splice(i, 1);
  const at = by?.before ? out.indexOf(by.before) : -1;
  if (at < 0) out.push(slug);
  else out.splice(at, 0, slug);
  return out;
}

export function buildScopeMenuModel(scope, data, t = enT, locale) {
  const active = orderProjects(
    activeNames(data),
    data,
    data?.projectOrder,
    locale,
  );
  const focus = scope?.focus ?? focusName(data);
  const multi = active.length > 1;
  const selected =
    scope?.scope && scope.scope !== "all" && active.includes(scope.scope)
      ? scope.scope
      : "all";
  const inView = Array.isArray(scope?.inView) ? scope.inView : active;
  const one = multi ? (selected === "all" ? null : selected) : active[0];
  const items = [
    ...(multi
      ? [
          {
            value: "all",
            label: t("ws.allN", { n: active.length }),
            checked: selected === "all",
            focused: false,
            title: t("ws.allTip"),
          },
        ]
      : []),
    ...active.map((n) => ({
      value: n,
      label: projectLabel(data, n),
      checked: n === one,
      focused: n === focus,
      title: t("ws.pickTip"),
    })),
  ];
  return {
    label:
      active.length === 0
        ? t("ws.noneLabel")
        : one
          ? projectLabel(data, one)
          : t("ws.all"),
    items,
    // Every workspace, active or not: ⌘K's Go to workspace (0.4.17).
    names: Object.keys(data?.workspaces ?? {}),
    focus: focus ?? null,
    title: t(focus ? "ws.viewTitleFocus" : "ws.viewTitle", {
      ws:
        inView.map((n) => projectLabel(data, n)).join(", ") ||
        t("ws.noneLabel"),
      focus: focus ? projectLabel(data, focus) : focus,
    }),
  };
}

/**
 * " · a, b" after a service that several workspaces in view define (it is
 * listed once); "" when one does.
 */
export function ownersLabel(owners) {
  return Array.isArray(owners) && owners.length > 1
    ? ` · ${owners.join(", ")}`
    : "";
}
