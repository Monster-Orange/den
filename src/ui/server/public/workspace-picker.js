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
  "ws.allTip":
    "Every active workspace; a service several define is listed once",
  "ws.noneLabel": "none",
  "ws.viewTitle":
    "View: what every page shows ({ws}). A view filter only: it starts, stops and routes nothing.",
  "ws.viewTitleFocus":
    "View: what every page shows ({ws}). It starts, stops and routes nothing. CLI default: {focus}.",
  "ws.pickTip":
    "Picking a workspace here also makes it the CLI default, so __DEN_CLI__ commands run there.",
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
export function buildScopeMenuModel(scope, data, t = enT) {
  const active = activeNames(data);
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
      label: n,
      checked: n === one,
      focused: n === focus,
      title: t("ws.pickTip"),
    })),
  ];
  return {
    label: active.length === 0 ? t("ws.noneLabel") : (one ?? t("ws.all")),
    items,
    focus: focus ?? null,
    title: t(focus ? "ws.viewTitleFocus" : "ws.viewTitle", {
      ws: inView.join(", ") || t("ws.noneLabel"),
      focus,
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
