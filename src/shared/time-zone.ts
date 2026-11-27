import { readUserConfig, type UserConfig } from "./den-config.js";

/** True when `v` is a zone this runtime can format in. */
export function isTimeZone(v: unknown): v is string {
  if (typeof v !== "string" || !v || v.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: v });
    return true;
  } catch {
    return false;
  }
}

/** The stored value, normalised: unknown or missing is null (the browser's). */
export function timeZonePref(stored: unknown): string | null {
  return isTimeZone(stored) ? stored : null;
}

export function personTimeZone(
  read: () => Pick<UserConfig, "time_zone"> = readUserConfig,
): string | undefined {
  try {
    return timeZonePref(read().time_zone) ?? undefined;
  } catch {
    return undefined;
  }
}
