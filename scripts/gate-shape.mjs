#!/usr/bin/env node
/**
 * Checks each live check in a folder (default: gate/) has the shape the bed
 * harness loads (CONTRIBUTING.md, "Live checks"):
 *
 *   gate/<issue>.mjs exports
 *     issue     the issue number, the same as the file name
 *     clauses   the issue's clauses it proves, by name (non-empty)
 *     setup(ctx)            prepares the bed, returns state
 *     run(ctx, state)       acts through ctx.url (HTTP or a browser page)
 *                           and ctx.cli(args); returns what it saw
 *     expect(result)        [{ clause, ok, skip?, detail?, evidence? }],
 *                           one per clause; ok null (not run) only with skip
 *                           "person" or "needs-<thing>"
 *   and may export
 *     teardown(ctx, state)  always called, even when run throws
 *     matrix                { browsers: chromium|webkit[], widths: px[] };
 *                           run is called once per cell, expect gets
 *                           [{ cell, result }]
 *     timeoutMs             a cell's time limit (the harness's default
 *                           otherwise); over it, the cell is ok false
 *
 * Prints a JSON array of problems (empty when all is well); exits 1 when
 * there are any. Loads each file, so a file that throws on import counts.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

export function checkGateModule(file, mod) {
  const out = [];
  const m = /^(\d+)\.mjs$/.exec(file);
  if (!m) return [`${file}: the name is not <issue number>.mjs`];
  if (mod.issue !== Number(m[1]))
    out.push(`${file}: issue is ${mod.issue}, the file name says ${m[1]}`);
  if (!Array.isArray(mod.clauses) || mod.clauses.length === 0)
    out.push(`${file}: clauses is empty (name each clause it proves)`);
  for (const fn of ["setup", "run", "expect"])
    if (typeof mod[fn] !== "function")
      out.push(`${file}: ${fn} is not a function`);
  // The harness calls expect(result) alone: a second parameter is always
  // undefined there, so whatever reads it fails on the bed (issue 455).
  if (typeof mod.expect === "function" && mod.expect.length > 1)
    out.push(
      `${file}: expect takes one argument, the result (the harness calls expect(result)); it declares ${mod.expect.length}`,
    );
  if ("teardown" in mod && typeof mod.teardown !== "function")
    out.push(`${file}: teardown is not a function`);
  if ("matrix" in mod) {
    const m = mod.matrix ?? {};
    const browsers = Array.isArray(m.browsers) ? m.browsers : [];
    const widths = Array.isArray(m.widths) ? m.widths : [];
    if (!browsers.length || browsers.some((b) => !BROWSERS.includes(b)))
      out.push(`${file}: matrix.browsers must list ${BROWSERS.join(" or ")}`);
    if (!widths.length || widths.some((w) => !Number.isInteger(w) || w < 200))
      out.push(`${file}: matrix.widths must be widths in px (200 or more)`);
  }
  if (
    "timeoutMs" in mod &&
    !(Number.isInteger(mod.timeoutMs) && mod.timeoutMs > 0)
  )
    out.push(`${file}: timeoutMs is not a positive whole number`);
  return out;
}

/**
 * A module's own plain `fetch` runs on the host, where the browser's
 * address (ctx.url) reaches the live edge; the harness refuses it there.
 * Host-side fetches use ctx.hostUrl (or ctx.fetch / ctx.api). Flags a
 * plain fetch whose address is built from ctx.url: `fetch(ctx.url…)`,
 * `fetch(\`${ctx.url}…\`)` and `fetch(new URL(…, ctx.url))`. A fetch
 * inside page.evaluate takes a relative path, so it never matches.
 */
const HOST_FETCH_AT_URL =
  /(?<![\w.$])fetch\(\s*(?:ctx\.url\b|`\$\{\s*ctx\.url\s*\}|new URL\([^()]*?,\s*ctx\.url\s*\))/g;

export function checkGateSource(file, src) {
  const out = [];
  for (const m of String(src).matchAll(HOST_FETCH_AT_URL)) {
    const line = src.slice(0, m.index).split("\n").length;
    out.push(
      `${file}: line ${line}: a plain fetch against ctx.url runs on the host and reaches the live edge; use ctx.hostUrl (or ctx.fetch)`,
    );
  }
  return out;
}

const BROWSERS = ["chromium", "webkit"];
const SKIP = /^(person|needs-[a-z0-9][a-z0-9-]*)$/;

/** What expect() returned, checked as the harness records it. */
export function checkRows(rows, clauses) {
  if (!Array.isArray(rows)) return ["expect did not return a list"];
  const out = [];
  // CONTRIBUTING.md: expect answers each clause once.
  const seen = new Set();
  for (const [i, r] of rows.entries()) {
    const at = `row ${i + 1}`;
    if (!clauses.includes(r?.clause))
      out.push(`${at}: clause "${r?.clause}" is not one of clauses`);
    else if (seen.has(r.clause))
      out.push(`${at}: clause "${r.clause}" is answered more than once`);
    else seen.add(r.clause);
    if (r?.ok === null) {
      if (!SKIP.test(String(r.skip ?? "")))
        out.push(`${at}: ok null needs skip "person" or "needs-<thing>"`);
    } else if (typeof r?.ok !== "boolean")
      out.push(`${at}: ok is not true, false or null`);
    else if ("skip" in r) out.push(`${at}: skip only goes with ok null`);
    if (
      "evidence" in r &&
      !(
        Array.isArray(r.evidence) &&
        r.evidence.every((e) => typeof e === "string")
      )
    )
      out.push(`${at}: evidence is not a list of names`);
  }
  for (const c of clauses)
    if (!rows.some((r) => r?.clause === c))
      out.push(`clause "${c}" has no row`);
  return out;
}

export async function checkGateDir(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const f of fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".mjs"))
    .sort()) {
    try {
      out.push(
        ...checkGateModule(
          f,
          await import(pathToFileURL(path.resolve(dir, f)).href),
        ),
      );
      if (/^\d+\.mjs$/.test(f))
        out.push(
          ...checkGateSource(f, fs.readFileSync(path.resolve(dir, f), "utf-8")),
        );
    } catch (e) {
      out.push(
        `${f}: does not load (${String(e?.message ?? e).split("\n")[0]})`,
      );
    }
  }
  return out;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const problems = await checkGateDir(process.argv[2] ?? "gate");
  console.log(JSON.stringify(problems));
  process.exit(problems.length ? 1 : 0);
}
