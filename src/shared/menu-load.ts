import { readUserConfig, type UserConfig } from "./den-config.js";

export const MENU_LOAD = {
  timeout_ms: { default: 8000, min: 1000, max: 600_000 },
} as const;

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
    v = undefined;
  }
  return typeof v === "number" &&
    Number.isInteger(v) &&
    v >= r.min &&
    v <= r.max
    ? v
    : r.default;
}
