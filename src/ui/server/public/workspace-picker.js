/**
 * Workspace pill / picker models.
 *
 * Pure and DOM-free (like perf-report.js) so the shape of the header's
 * workspace menu is unit-testable under Jest's node environment; header.js
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
 * Label + tooltip for the header pill.
 * Falls back to "default" so the pill never renders empty.
 */
export function buildWorkspacePillModel(data) {
  const active = activeNames(data);
  const label = focusName(data) ?? "default";
  return {
    label,
    // Only worth spelling out when more than one workspace is active —
    // otherwise the pill text already says everything.
    title:
      active.length > 1
        ? `Active: ${active.join(", ")} · Focus: ${label}`
        : "Switch workspace",
  };
}

/**
 * Menu model for the pill's dropdown: every known workspace, active ones
 * first (they are the likely targets), each side alphabetical so the list
 * order is stable across polls.
 */
export function buildWorkspaceMenuModel(data) {
  const active = new Set(activeNames(data));
  const focus = focusName(data);
  // Union of the catalog and the active set: a workspace listed as active but
  // missing from `workspaces` still has to be selectable (and visible).
  const names = new Set([...Object.keys(data?.workspaces ?? {}), ...active]);

  const items = [...names].map((name) => ({
    name,
    active: active.has(name),
    focused: name === focus,
  }));
  items.sort(
    (a, b) =>
      Number(b.active) - Number(a.active) || a.name.localeCompare(b.name),
  );

  return { focus, items };
}
