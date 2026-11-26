/**
 * Issue 1527: visual-reference tests go only to a box serving their
 * references' browser build.
 *
 * A test that compares a render against a stored reference (pixels, or
 * measured rects and styles in a committed file) carries VISUAL_TAG in
 * its top comment, naming the record of the browser its references were
 * taken on (VISUAL_ENV_FILE next to them: platform, Chromium build, font
 * widths). A test box may serve another build of the same Playwright (an
 * Apple-silicon box runs the image's arm64 build, natively), where text
 * lands differently. So a run with a tagged test goes only to a box whose
 * browser matches every record it names: the others are skipped, or
 * refused when named, saying how they differ.
 */
import type { Browser } from "@playwright/test";
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
  // A comment line of its own (` * @visual-reference …`): a mention in
  // prose or a string isn't the tag.
  return /^[ \t]*\*[ \t]*@visual-reference\b/m.test(text.slice(0, HEAD_BYTES));
}

/**
 * The record a tagged test names (`@visual-reference <path>`, from the
 * repo's top), or undefined when the tag names none.
 */
export function visualRecordOf(text: string): string | undefined {
  return /^[ \t]*\*[ \t]*@visual-reference[ \t]+([\w./-]+\.json)\b/m.exec(
    text.slice(0, HEAD_BYTES),
  )?.[1];
}

/**
 * Each tagged file's record (read), or why it has none. `files` are
 * relative to `cwd`; a record's path is from `top`.
 */
export function visualRecords(
  files: string[],
  cwd: string,
  top: string,
): { file: string; env: VisualEnv | string }[] {
  const seen = new Map<string, VisualEnv | string>();
  const out: { file: string; env: VisualEnv | string }[] = [];
  for (const f of files) {
    const rec = visualRecordOf(readHead(path.resolve(cwd, f)));
    if (!rec) {
      out.push({ file: f, env: "its @visual-reference tag names no record" });
      continue;
    }
    if (!seen.has(rec)) seen.set(rec, readVisualEnv(path.join(top, rec)));
    out.push({ file: rec, env: seen.get(rec)! });
  }
  // One entry per record (or per file that names none).
  return out.filter((x, i) => out.findIndex((y) => y.file === x.file) === i);
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

/**
 * The browser a set of references was taken on, or a box serves: where
 * text lands. Kept next to the references (`visual-env.json`, written by
 * the test's capture), and read from a box through its Playwright server.
 */
export interface VisualEnv {
  /** `linux/amd64`, `linux/arm64`: Chromium's UA says x86_64 on both. */
  platform: string;
  /** `browser.version()`, like 149.0.7827.55. */
  chromium: string;
  /** Each face's width of one fixed line, px to 3 places. */
  fonts: Record<string, number>;
}

/** The record's name, in the folder of the references it describes. */
export const VISUAL_ENV_FILE = "visual-env.json";

/** System faces measured: the generic families and the kit's stacks. */
const FAMILIES = [
  "sans-serif",
  "serif",
  "monospace",
  '-apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif',
  'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
];
const FACES = FAMILIES.flatMap((f) =>
  ["400", "500"].map((w) => `${w} 14px ${f}`),
);

/**
 * In a secure page (userAgentData needs one): the platform, from the
 * architecture and bitness, and each face's width of one line laid out
 * in a hidden span. A string, so this file needs no DOM types.
 */
const ENV_SCRIPT = `(async () => {
  const h = navigator.userAgentData
    ? await navigator.userAgentData.getHighEntropyValues(["architecture", "bitness"])
    : {};
  const os = ((navigator.userAgentData && navigator.userAgentData.platform) || "").toLowerCase();
  const arch = h.architecture === "x86" && h.bitness === "64" ? "amd64"
    : h.architecture === "arm" && h.bitness === "64" ? "arm64"
    : (h.architecture || "unknown") + (h.bitness || "");
  const span = document.createElement("span");
  span.style.cssText = "position:absolute;left:-10000px;top:0;white-space:pre;letter-spacing:normal;visibility:hidden";
  span.textContent = "Den shell metrics: Reload, Report, 0123456789";
  document.body.appendChild(span);
  const fonts = {};
  for (const f of ${JSON.stringify(FACES)}) {
    const [weight, size, ...family] = f.split(" ");
    span.style.fontWeight = weight;
    span.style.fontSize = size;
    span.style.fontFamily = family.join(" ");
    fonts[f] = Math.round(span.getBoundingClientRect().width * 1000) / 1000;
  }
  span.remove();
  return { platform: (os || "unknown") + "/" + arch, fonts };
})()`;

/**
 * A browser's VisualEnv, in a page of its own: a stub served at an https
 * address by the page's own route (nothing goes out), so userAgentData is
 * there. The tests' capture writes it; the gate reads boxes with it.
 */
export async function visualEnvOf(browser: Browser): Promise<VisualEnv> {
  const page = await browser.newPage();
  try {
    await page.route("**/*", (r) =>
      r.fulfill({
        status: 200,
        contentType: "text/html",
        body: "<!doctype html><title>env</title><body></body>",
      }),
    );
    await page.goto("https://visual-env.invalid/");
    const got = await page.evaluate<Omit<VisualEnv, "chromium">>(ENV_SCRIPT);
    return { chromium: browser.version(), ...got };
  } finally {
    await page.close().catch(() => undefined);
  }
}

/** Writes the record next to the references (capture mode). */
export function writeVisualEnv(dir: string, env: VisualEnv): void {
  writeFileAtomic(
    path.join(dir, VISUAL_ENV_FILE),
    JSON.stringify(env, null, 2) + "\n",
  );
}

/** A record, if the file holds one; else why not. */
export function readVisualEnv(file: string): VisualEnv | string {
  let v: unknown;
  try {
    v = JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch (e) {
    return `no reference record at ${file} (${(e as Error).message.split("\n")[0]})`;
  }
  const r = v as Partial<VisualEnv>;
  if (
    typeof r?.platform !== "string" ||
    typeof r.chromium !== "string" ||
    !r.fonts ||
    typeof r.fonts !== "object" ||
    !Object.values(r.fonts).every((n) => typeof n === "number")
  )
    return `${file} is not a reference record (platform, chromium, fonts)`;
  return { platform: r.platform, chromium: r.chromium, fonts: r.fonts };
}

/**
 * How a box's browser differs from the references' record, in words, or
 * "" when it is the same: platform, build, and every recorded face's
 * width. A face the box doesn't report differs.
 */
export function envMismatch(want: VisualEnv, got: VisualEnv): string {
  if (got.platform !== want.platform)
    return `is ${got.platform}; the references were taken on ${want.platform}`;
  if (got.chromium !== want.chromium)
    return `serves Chromium ${got.chromium}; the references were taken on ${want.chromium}`;
  for (const [face, w] of Object.entries(want.fonts)) {
    const g = got.fonts[face];
    if (g !== w)
      return `draws ${face} ${g === undefined ? "not at all" : `${g} px wide`}; the references ${w} px`;
  }
  return "";
}

export type BrowserRead = (ws: string, timeoutMs: number) => Promise<VisualEnv>;

/**
 * `p`, or a rejection "no answer in N s" once `ms` pass: one deadline on
 * the whole read (connect, page, probe), so a box that connects and then
 * stalls never holds a gate run.
 */
export function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`no answer in ${Math.round(ms / 1000)} s`)),
      ms,
    );
  });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}

/** One connect to the box's server, and its VisualEnv. */
export const realBrowserRead: BrowserRead = async (ws, timeoutMs) => {
  const { chromium } = await import("@playwright/test");
  let browser: Browser | undefined;
  const read = (async () => {
    browser = await chromium.connect(ws, { timeout: timeoutMs });
    return visualEnvOf(browser);
  })();
  try {
    return await withDeadline(read, timeoutMs);
  } finally {
    // Also after a timeout: a stalled connection is closed now, and one
    // that connects late is closed when it does.
    const close = () => browser?.close().catch(() => undefined);
    void read.then(close, close);
    await close();
  }
};

/** A box's last read, kept for gate status. */
export interface BoxBrowserState {
  platform?: string;
  chromium?: string;
  fonts?: Record<string, number>;
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
 * Reads each box's VisualEnv (one connect each, in parallel), keeps the
 * reads for gate status, and says which match every record the run's
 * tagged tests name. A box with no server for the run's Playwright, or
 * whose browser can't be read, is unfit: never assumed to match.
 */
export async function visualFit(o: {
  boxes: GateBox[];
  /** Each tagged test's record, or why it has none. */
  records: { file: string; env: VisualEnv | string }[];
  pwVersion: string | undefined;
  read: BrowserRead;
  timeoutMs: number;
  dir: string;
  now: () => number;
}): Promise<VisualFit> {
  const out: VisualFit = { fit: [], unfit: [] };
  const bad = o.records.find((r) => typeof r.env === "string");
  if (bad) {
    for (const b of o.boxes)
      out.unfit.push({
        name: b.name,
        why: `${bad.file}: ${bad.env as string}`,
      });
    return out;
  }
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
        // Any read, the real one or not, gets the one deadline.
        return {
          b,
          got: await withDeadline(o.read(ws, o.timeoutMs), o.timeoutMs),
        };
      } catch (e) {
        return { b, error: oneLine((e as Error).message.split("\n")[0] ?? "") };
      }
    }),
  );
  const kept = readBoxBrowsers(o.dir);
  for (const r of reads) {
    if (r.got) kept[r.b.name] = { ...r.got, at };
    else if (r.error !== undefined) kept[r.b.name] = { error: r.error, at };
  }
  try {
    writeFileAtomic(
      path.join(o.dir, STATE_FILE),
      JSON.stringify(kept, null, 2) + "\n",
    );
  } catch {
    // Status only: the routing below doesn't need it.
  }
  for (const r of reads) {
    const name = r.b.name;
    if (r.why) out.unfit.push({ name, why: r.why });
    else if (r.error !== undefined)
      out.unfit.push({
        name,
        why: `box ${name}: its browser couldn't be read (${r.error})`,
      });
    else if (r.got) {
      const miss = o.records
        .map((rec) => ({ rec, m: envMismatch(rec.env as VisualEnv, r.got!) }))
        .find((x) => x.m);
      if (miss)
        out.unfit.push({
          name,
          why: `box ${name} ${miss.m} (${miss.rec.file})`,
        });
      else out.fit.push(name);
    }
  }
  return out;
}
