/**
 * The owners label a shared service carries in a list.
 *
 * 0.4.3 (WS-6): the top bar's Workspace menu moved to workspace-switch.js
 * (its pure parts: workspace-status.js). What stays here is the one helper
 * the Services list, the Graph and the Tests page import.
 */

/** No strings of its own any more (i18n.test.ts holds this to en). */
export const EN_FALLBACK = {};

/**
 * " · a, b" after a service that several workspaces in view define (it is
 * listed once); "" when one does.
 */
export function ownersLabel(owners) {
  return Array.isArray(owners) && owners.length > 1
    ? ` · ${owners.join(", ")}`
    : "";
}
