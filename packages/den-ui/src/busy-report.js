import { BUSY_WORDS } from "./busy-words.js";

const ID = /^[A-Za-z0-9._:-]{1,128}$/;
const METHOD = /^[A-Z]{3,7}$/;
const PATH = /^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]{0,300}$/;

function pick(words, lang, key, vars) {
  const s =
    words?.[lang]?.[key] ??
    BUSY_WORDS[lang]?.[key] ??
    words?.en?.[key] ??
    BUSY_WORDS.en[key] ??
    key;
  return String(s).replace(/\{(\w+)\}/g, (m, k) =>
    vars && vars[k] !== undefined ? String(vars[k]) : m,
  );
}

function pathWithoutOriginQueryOrHash(url) {
  if (typeof url !== "string" || !url) return "";
  let p;
  try {
    p = new URL(url, "http://x.invalid").pathname;
  } catch {
    return "";
  }
  return PATH.test(p) && url.trim() === url && !/\s/.test(url) ? p : "";
}

const PLAIN_WORD_ELSE_ID = /^(?=.{1,24}$)[a-z]{1,12}(-[a-z]{1,12})?$/;
const idsAsPlaceholders = (path) =>
  path
    .split("/")
    .map((seg) => (seg === "" || PLAIN_WORD_ELSE_ID.test(seg) ? seg : ":id"))
    .join("/");

function routeOf(err) {
  const raw = pathWithoutOriginQueryOrHash(err?.url);
  const path = raw ? idsAsPlaceholders(raw) : "";
  if (!path) return "";
  const m = typeof err?.method === "string" ? err.method.toUpperCase() : "";
  return METHOD.test(m) ? `${m} ${path}` : path;
}

export function failureReport({ lang = "en", failure, err, id, at, words }) {
  const w = (key, vars) => pick(words, lang, key, vars);
  const what =
    String(failure ?? "")
      .trim()
      .replace(/[.。!！]+$/u, "") || w("report_failed");
  const code =
    !err?.network && Number.isInteger(err?.status) && err.status > 0
      ? err.status
      : 0;
  const title = code
    ? w("report_t", { what, code })
    : w("report_net", { what });
  const requestId = typeof id === "string" && ID.test(id) ? id : "";
  const route = routeOf(err);
  const when =
    at instanceof Date && !Number.isNaN(at.getTime()) ? at.toISOString() : "";
  const lines = [
    code ? `${w("report_status")}: ${code}` : "",
    route ? `${w("report_route")}: ${route}` : "",
    requestId ? `${w("report_id")}: ${requestId}` : "",
    when ? `${w("report_at")}: ${when}` : "",
  ].filter(Boolean);
  return { title, description: lines.join("\n"), requestId, route };
}
