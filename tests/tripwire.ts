/**
 * Tripwires every test file runs under (tests/setup.ts), 0.4.48: test runs
 * opened sign-in tabs in a person's browser and wrote this checkout's
 * config/local.
 *
 * - Openers: `open`, `osascript`, `xdg-open` and `x-www-browser` are shims
 *   first on the real PATH (global-setup.mjs), which every spawn inherits.
 *   A shim logs the call (the program and its first argument, a link's
 *   query never kept) and fails; the file that made one fails.
 * - config/local: a test file that adds, changes or removes anything under
 *   the checkout's config/local fails, naming it.
 */
import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";

/**
 * This worker's opener log: the shims global-setup.mjs puts first on the
 * real PATH write it, beside their folder, per JEST_WORKER_ID.
 */
function logFile(): string | null {
  const stubs = process.env.DEN_TEST_GLOBAL_STUBS;
  if (!stubs) return null;
  return path.join(
    path.dirname(stubs),
    `opener-calls-${process.env.JEST_WORKER_ID ?? "0"}.log`,
  );
}

/** Starts this test file with an empty log. */
export function armTripwire(): void {
  clearTripwire();
}

/** The opener calls made since the log was last cleared. */
export function tripwireCalls(): string[] {
  const file = logFile();
  if (!file) return [];
  try {
    return fs
      .readFileSync(file, "utf-8")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** Empties the log (a test that trips it on purpose). */
export function clearTripwire(): void {
  const file = logFile();
  if (file && fs.existsSync(path.dirname(file))) fs.writeFileSync(file, "");
}

/** Every file under `<root>/config/local`, by its path, with its hash. */
export function configLocalSnapshot(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const base = path.join(root, "config", "local");
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile())
        try {
          out.set(
            path.relative(root, p).split(path.sep).join("/"),
            createHash("sha1").update(fs.readFileSync(p)).digest("hex"),
          );
        } catch {
          /* gone while read: the next look says so */
        }
    }
  };
  walk(base);
  return out;
}

/** What changed under config/local since `before`: changed, removed, added. */
export function configLocalChanges(
  root: string,
  before: Map<string, string>,
): string[] {
  const now = configLocalSnapshot(root);
  const changed: string[] = [];
  const removed: string[] = [];
  const added: string[] = [];
  for (const [p, h] of before) {
    if (!now.has(p)) removed.push(`removed ${p}`);
    else if (now.get(p) !== h) changed.push(`changed ${p}`);
  }
  for (const p of now.keys()) if (!before.has(p)) added.push(`added ${p}`);
  return [...changed, ...removed, ...added];
}
