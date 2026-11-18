/**
 * Issue 169 (T2): a project's terminals are named "terminal-1",
 * "terminal-2", ... (shown as "Terminal 1", "Terminal 2"). A number is
 * never given twice in one project: the last one given is kept in
 * `<stateDir>/sessions/terminal-names.json` ({ "<project>": n }), so a
 * terminal that closed doesn't hand its name to the next one.
 */
import * as fs from "fs";
import * as path from "path";

const PREFIX = "terminal-";
const RE = /^terminal-([1-9]\d{0,8})$/;

/** The number in a terminal's own name ("terminal-3" -> 3); else null. */
export function terminalNumber(name: string): number | null {
  const m = RE.exec(name);
  return m ? Number(m[1]) : null;
}

function countFile(stateDir: string): string {
  return path.join(stateDir, "sessions", "terminal-names.json");
}

function readCounts(stateDir: string): Record<string, number> {
  try {
    const v: unknown = JSON.parse(fs.readFileSync(countFile(stateDir), "utf-8"));
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    const out: Record<string, number> = {};
    for (const [k, n] of Object.entries(v as Record<string, unknown>))
      if (typeof n === "number" && Number.isSafeInteger(n) && n > 0) out[k] = n;
    return out;
  } catch {
    return {};
  }
}

/**
 * The next terminal name in project `ws`: one above both the last number
 * given there and every live terminal name in `live` (the project's own
 * session names, without the `<dist>-<ws>:` part). Records it.
 */
export function nextTerminalName(
  stateDir: string,
  ws: string,
  live: Iterable<string>,
): string {
  const counts = readCounts(stateDir);
  let n = counts[ws] ?? 0;
  for (const name of live) n = Math.max(n, terminalNumber(name) ?? 0);
  n += 1;
  counts[ws] = n;
  const file = countFile(stateDir);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(counts) + "\n", { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch {
    // Unwritten: the live names still keep this one from repeating now.
  }
  return `${PREFIX}${n}`;
}
