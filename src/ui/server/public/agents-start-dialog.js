import { formatTime } from "/kit/time.js";

/**
 * Issue 482: agoText as plain text, for a time inside a translated
 * sentence ("Last used 3 minutes ago"), in the person's zone.
 */
function agoPlain(iso) {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  return formatTime(iso, { style: ms < 48 * 3600_000 ? "relative" : "date" });
}

export { agoPlain };
