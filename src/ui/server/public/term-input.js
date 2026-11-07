/**
 * The Agents tab's terminal input and links (AG-4b), pure helpers for
 * agents-page.js (and its tests):
 *
 *   isWebUrl(uri)          only http: and https: open (an OSC 8 link's
 *                          javascript:, data:, file: and the rest never)
 *   linkModifier(e, mac)   the click that opens a link: ⌘ on a Mac, Ctrl
 *                          elsewhere; a plain click still selects
 *   findPaths(line)        file paths in a line of output: `src/foo.ts:42`,
 *                          `./a/b.js:3:7`, `/abs/path`; never a URL
 *   editorUrl(ed, abs, l)  an editor's URL for a path and line (vscode,
 *                          cursor, zed); none: null (the path is copied)
 *   softNewlineKey(e)      Shift+Enter, and no other modifier
 *   layoutKeyIndex(e)      ⌃⇧1 / ⌃⇧2 / ⌃⇧3 (by the key's code: Shift+1 is
 *                          "!" on a US keyboard): 0-2, else -1. ⌘1-9 and
 *                          Ctrl+1-9 are the browser's (its tabs), never ours
 */

/** The editors a path link opens in, by URL scheme (Settings › editor.open). */
export const EDITORS = ["vscode", "cursor", "zed", "none"];

/** Whether `uri` is an http or https URL: the only links that open. */
export function isWebUrl(uri) {
  if (typeof uri !== "string" || !uri) return false;
  let u;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  return (u.protocol === "http:" || u.protocol === "https:") && !!u.host;
}

/** This browser is on a Mac (⌘ opens links there, Ctrl elsewhere). */
export function isMac(nav = globalThis.navigator) {
  const p = nav?.userAgentData?.platform || nav?.platform || "";
  return /mac|iphone|ipad/i.test(p);
}

/** The click opens a link: ⌘-click on a Mac, Ctrl-click elsewhere. */
export function linkModifier(e, mac = isMac()) {
  if (!e) return false;
  return mac ? !!e.metaKey : !!e.ctrlKey;
}

/**
 * A path, then an optional :line and :column. It never starts right after
 * a word character, a dot, a slash or a colon, so no part of a URL
 * (https://host/a/b) and no part of a longer word is one.
 */
const PATH_RE =
  /(?<![\w./~:@%+-])((?:\.{1,2}\/|\/)?[\w@+-][\w.@+-]*(?:\/[\w.@+-]+)*)(?::(\d+)(?::(\d+))?)?/g;
const EXT_RE = /[^/.]\.[A-Za-z0-9]{1,12}$/;

/**
 * The file paths in `line`: { text, start, end, path, line?, col? }, start
 * and end its columns in the line (end exclusive). A path has a "/" and
 * either starts with /, ./ or ../, has an extension or a line; or it is a
 * file name with an extension and a line (`foo.ts:12`). The server says
 * which of them exist in the agent's workspace (only those are links).
 */
export function findPaths(line) {
  const out = [];
  if (typeof line !== "string" || !line) return out;
  PATH_RE.lastIndex = 0;
  for (let m; (m = PATH_RE.exec(line)); ) {
    let p = m[1];
    const ln = m[2] === undefined ? undefined : Number(m[2]);
    const col = m[3] === undefined ? undefined : Number(m[3]);
    let text = m[0];
    if (ln === undefined) {
      // A sentence's full stop is not the path's.
      const trimmed = p.replace(/\.+$/, "");
      text = trimmed;
      p = trimmed;
    }
    if (!p) continue;
    const slash = p.includes("/");
    const rooted = /^(?:\/|\.{1,2}\/)/.test(p);
    const ext = EXT_RE.test(p);
    const ok = slash
      ? rooted || ext || ln !== undefined
        ? !/^\d+\/\d+$/.test(p)
        : false
      : ext && ln !== undefined;
    if (!ok) continue;
    out.push({
      text,
      start: m.index,
      end: m.index + text.length,
      path: p,
      ...(ln !== undefined ? { line: ln } : {}),
      ...(col !== undefined ? { col } : {}),
    });
  }
  return out;
}

/**
 * The URL that opens `abs` at `line` (and `col`) in `editor`, or null:
 * none, an editor Den doesn't know, or a path that isn't absolute.
 */
export function editorUrl(editor, abs, line, col) {
  if (!["vscode", "cursor", "zed"].includes(editor)) return null;
  if (typeof abs !== "string" || !abs.startsWith("/")) return null;
  const p = abs.split("/").map(encodeURIComponent).join("/");
  const at = line ? `:${line}${col ? `:${col}` : ""}` : "";
  return `${editor}://file${p}${at}`;
}

/** Shift+Enter, no other modifier: the soft newline. */
export function softNewlineKey(e) {
  return (
    e?.type === "keydown" &&
    e.key === "Enter" &&
    e.shiftKey &&
    !e.ctrlKey &&
    !e.altKey &&
    !e.metaKey &&
    !e.isComposing
  );
}

/** ⌃⇧1, ⌃⇧2, ⌃⇧3: the layouts' index; else -1. */
export function layoutKeyIndex(e) {
  if (e?.type !== "keydown") return -1;
  if (!e.ctrlKey || !e.shiftKey || e.metaKey || e.altKey) return -1;
  return ["Digit1", "Digit2", "Digit3"].indexOf(e.code);
}
