/**
 * Issue 1527: visual-reference tests go only to a box serving their
 * references' browser build.
 *
 * A test that compares a render against a stored reference (pixels, or
 * measured rects and styles in a committed file) carries VISUAL_TAG in
 * its top comment. Its references were taken on the Chromium build that
 * the run's pinned Playwright installs (CI's). A test box may serve
 * another build of the same Playwright (an Apple-silicon box runs the
 * image's arm64 build, natively), where text lands differently. So a run
 * with a tagged test goes only to a box whose Chromium reports that build:
 * the others are skipped, or refused when named, saying both builds.
 */
import * as fs from "fs";
import * as path from "path";
import { writeFileAtomic } from "../atomic-write.js";
import { boxEndpointFor, type GateBox } from "./boxes.js";

export const VISUAL_TAG = "@visual-reference";

/** Bytes of a test file read for the tag: its top comment is there. */
const HEAD_BYTES = 4096;
/** Files looked at, at most, under a folder a run names. */
const WALK_CAP = 5000;

/** Whether a test file's text carries the tag. */
export function hasVisualTag(text: string): boolean {
  return /@visual-reference\b/.test(text.slice(0, HEAD_BYTES));
}

function readHead(file: string): string {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(HEAD_BYTES);
    return buf.toString("utf-8", 0, fs.readSync(fd, buf, 0, HEAD_BYTES, 0));
  } catch {
    return "";
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;

/** Tagged test files under `dir` (node_modules and dot folders skipped). */
function taggedUnder(dir: string, out: string[], seen: { n: number }): void {
  let names: fs.Dirent[];
  try {
    names = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of names) {
    if (seen.n >= WALK_CAP) return;
    if (e.name.startsWith(".") || e.name === "node_modules") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) taggedUnder(p, out, seen);
    else if (e.isFile() && TEST_FILE.test(e.name)) {
      seen.n++;
      if (hasVisualTag(readHead(p))) out.push(p);
    }
  }
}

/**
 * The tagged test files a run takes: each argument that is a test file
 * with the tag, or a folder holding some; with `allTests`, every tagged
 * test under `top` (the repo). Paths relative to `cwd`.
 */
export function visualFilesInRun(
  cwd: string,
  args: string[],
  allTests: boolean,
  top: string = cwd,
): string[] {
  const out: string[] = [];
  const seen = { n: 0 };
  if (allTests) taggedUnder(top, out, seen);
  for (const a of args) {
    if (a.startsWith("-")) continue;
    const p = path.resolve(cwd, a);
    let st: fs.Stats;
    try {
      st = fs.statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) taggedUnder(p, out, seen);
    else if (st.isFile() && TEST_FILE.test(p) && hasVisualTag(readHead(p)))
      out.push(p);
  }
  return [...new Set(out)].map((p) => path.relative(cwd, p) || p);
}

/**
 * The Chromium build the run's pinned Playwright installs (its
 * playwright-core's browsers.json), the nearest at or above `cwd`;
 * undefined when none is installed.
 */
export function pinnedChromium(cwd: string): string | undefined {
  for (let d = path.resolve(cwd); ; d = path.dirname(d)) {
    try {
      const j = JSON.parse(
        fs.readFileSync(
          path.join(d, "node_modules", "playwright-core", "browsers.json"),
          "utf-8",
        ),
      ) as { browsers?: { name?: string; browserVersion?: string }[] };
      const v = j.browsers?.find((b) => b.name === "chromium")?.browserVersion;
      if (typeof v === "string" && /^[\d.]{1,40}$/.test(v)) return v;
    } catch {
      // Not here: look higher.
    }
    if (path.dirname(d) === d) return undefined;
  }
}

/** What a box's Playwright server's Chromium says of itself. */
export interface BrowserBuild {
  /** `browser.version()`, like 149.0.7827.55. */
  chromium: string;
  /** Canvas text widths: where text lands, beside the build. */
  fonts: string;
}

export type BrowserRead = (
  ws: string,
  timeoutMs: number,
) => Promise<BrowserBuild>;

/** The text the fingerprint measures, in the faces the kit uses. */
const FACES = [
  "15px Rubik",
  "15px sans-serif",
  "13px monospace",
];

/** One connect to the box's server: its Chromium build and fonts. */
export const realBrowserRead: BrowserRead = async (ws, timeoutMs) => {
  const { chromium } = await import("@playwright/test");
  const browser = await chromium.connect(ws, { timeout: timeoutMs });
  try {
    const page = await browser.newPage();
    // A script in the page (this file has no DOM types): the widths of
    // one line in each face, as the parity test measures them.
    const fonts = await page.evaluate<string>(
      `(() => { const c = document.createElement("canvas").getContext("2d");` +
        ` const line = "Den shell metrics: Reload, Report, 0123456789";` +
        ` return ${JSON.stringify(FACES)}.map((f) => { c.font = f;` +
        ` return f + "=" + c.measureText(line).width.toFixed(3); }).join(" | "); })()`,
    );
    return { chromium: browser.version(), fonts };
  } finally {
    await browser.close().catch(() => undefined);
  }
};

/** A box's last read, kept for gate status. */
export interface BoxBrowserState {
  chromium?: string;
  fonts?: string;
  /** Why it couldn't be read, when it couldn't. */
  error?: string;
  at: string;
}

const STATE_FILE = "boxes-browser.json";

export function readBoxBrowsers(dir: string): Record<string, BoxBrowserState> {
  try {
    const v = JSON.parse(
      fs.readFileSync(path.join(dir, STATE_FILE), "utf-8"),
    ) as unknown;
    return v && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, BoxBrowserState>)
      : {};
  } catch {
    return {};
  }
}

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, 200);

/** Which boxes may take a visual run, and why each other one can't. */
export interface VisualFit {
  fit: string[];
  unfit: { name: string; why: string }[];
}

/**
 * Reads each box's Chromium (one connect each, in parallel), keeps the
 * reads for gate status, and says which serve `want`. A box with no
 * server for the run's Playwright, or whose build can't be read, is
 * unfit: never assumed to match.
 */
export async function visualFit(o: {
  boxes: GateBox[];
  want: string | undefined;
  pwVersion: string | undefined;
  read: BrowserRead;
  timeoutMs: number;
  dir: string;
  now: () => number;
}): Promise<VisualFit> {
  const at = new Date(o.now()).toISOString();
  const reads = await Promise.all(
    o.boxes.map(async (b) => {
      const ws = boxEndpointFor(b, o.pwVersion);
      if (!ws)
        return {
          b,
          why: `box ${b.name} serves no Playwright of this run's version`,
        };
      try {
        return { b, got: await o.read(ws, o.timeoutMs) };
      } catch (e) {
        return {
          b,
          error: oneLine((e as Error).message.split("\n")[0] ?? ""),
        };
      }
    }),
  );
  const kept = readBoxBrowsers(o.dir);
  for (const r of reads) {
    if ("got" in r && r.got)
      kept[r.b.name] = { chromium: r.got.chromium, fonts: r.got.fonts, at };
    else if ("error" in r) kept[r.b.name] = { error: r.error, at };
  }
  try {
    writeFileAtomic(
      path.join(o.dir, STATE_FILE),
      JSON.stringify(kept, null, 2) + "\n",
    );
  } catch {
    // Status only: the routing below doesn't need it.
  }
  const out: VisualFit = { fit: [], unfit: [] };
  for (const r of reads) {
    const name = r.b.name;
    if ("why" in r && r.why) out.unfit.push({ name, why: r.why });
    else if ("error" in r)
      out.unfit.push({
        name,
        why: `box ${name}: its Chromium build couldn't be read (${r.error})`,
      });
    else if (!o.want)
      out.unfit.push({
        name,
        why: "the references' Chromium build is unknown (no playwright-core installed for this run)",
      });
    else if ("got" in r && r.got && r.got.chromium === o.want)
      out.fit.push(name);
    else if ("got" in r && r.got)
      out.unfit.push({
        name,
        why: `box ${name} serves Chromium ${r.got.chromium}; the visual references need ${o.want}`,
      });
  }
  return out;
}
