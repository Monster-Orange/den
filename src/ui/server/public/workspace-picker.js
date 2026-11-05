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
 * the health row and `status` show. Choosing an entry never moves the
 * focus (the default target for commands); the focused workspace is
 * marked, and `focusable` names the workspace in view when it is not the
 * focus, for the menu's separate "Set <ws> as focus" item.
 *
 * "All active" is offered with two or more active workspaces; with one,
 * it and that workspace are the same view.
 */
export function buildScopeMenuModel(scope, data) {
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
            label: `All active (${active.length})`,
            checked: selected === "all",
            focused: false,
            title:
              "Every active workspace; a service several define is listed once",
          },
        ]
      : []),
    ...active.map((n) => ({
      value: n,
      label: n,
      checked: n === one,
      focused: n === focus,
    })),
  ];
  return {
    label: active.length === 0 ? "none" : (one ?? "All active"),
    items,
    focusable: one && one !== focus ? one : null,
    title:
      `View: what every page shows (${inView.join(", ") || "none"}). ` +
      "A view filter only: it starts, stops and routes nothing" +
      (focus ? `, and focus (${focus}) stays the target for commands.` : "."),
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
