/**
 * Issue 1051: how long the top bar waits for its project menu's load
 * (/api/workspaces, /api/scope) before it counts as failed and is tried
 * again. A stalled connection never errors, so without it the menu would
 * stay hidden until a reload (issue 1044's WebKit wait after a pick).
 *
 * user.yml web.menu_load_timeout_ms: 8000 by default, 1000 to 600000.
 */
import { readUserConfig, type UserConfig } from "./den-config.js";

export const MENU_LOAD = {
  timeout_ms: { default: 8000, min: 1000, max: 600_000 },
} as const;

/** user.yml web.menu_load_timeout_ms, or its default. */
export function menuLoadTimeoutMs(
  read: () => UserConfig = readUserConfig,
): number {
  const r = MENU_LOAD.timeout_ms;
  let v: unknown;
  try {
    const w = read().web;
    if (w && typeof w === "object" && !Array.isArray(w))
      v = (w as Record<string, unknown>).menu_load_timeout_ms;
  } catch {
    /* the default */
  }
  return typeof v === "number" &&
    Number.isInteger(v) &&
    v >= r.min &&
    v <= r.max
    ? v
    : r.default;
}
