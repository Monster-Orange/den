/**
 * Issue 840: live checks read Den's CLI through its --json form, never by
 * splitting or matching the words it prints for a person.
 *
 * Clause 1: every live check (gate/*.mjs) that reads a CLI command's output
 * passes --json. A call read only for its exit code is fine, and so is the
 * error text of a refusal read whole (gate/441: the words an agent is told
 * are what it tests).
 * Clause 3: no live check reads CLI output by position or line: no
 * `.split(…)[n]`, `.match(…)[n]` or `.split("\n")` over what a command
 * printed.
 *
 * The checker is the pure `cliReads(src)` below; it is seen red on planted
 * reads first, then run over every gate/*.mjs.
 */
import { describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";

const ROOT = path.resolve(__dirname, "../../..");
const GATE = path.join(ROOT, "gate");

/** One finding: the line, and what was wrong. */
type Hit = { line: number; what: string };

/** The CLI calls in a live check, their argument list, and the name its result is kept under. */
function cliCalls(src: string) {
  const out: { at: number; args: string; name: string | null }[] = [];
  const re = /\bcli\(\s*\[/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    // The literal list, to its matching "]" (an argument may index: LOOPS[0]).
    let depth = 0;
    let end = m.index + m[0].length - 1;
    for (; end < src.length; end++) {
      if (src[end] === "[") depth++;
      else if (src[end] === "]" && --depth === 0) break;
    }
    const args = src.slice(m.index + m[0].length, end);
    const before = src.slice(Math.max(0, m.index - 80), m.index);
    const named =
      /(?:const|let|var)\s+([\w$]+)\s*=\s*(?:await\s+)?(?:\(\s*await\s+)?(?:[\w$]+\.)*$/.exec(
        before,
      );
    out.push({ at: m.index, args, name: named ? named[1]! : null });
  }
  return out;
}

const lineAt = (src: string, at: number) => src.slice(0, at).split("\n").length;

/**
 * Where a live check reads CLI text: a call's .out read without --json,
 * and any split or match over a call's output (directly, or through a
 * variable built from it).
 */
export function cliReads(src: string, wordsUnderTest = false): Hit[] {
  const hits: Hit[] = [];
  const tainted = new Set<string>();
  for (const c of cliCalls(src)) {
    const json = /["'`]--json["'`]/.test(c.args);
    // The call's own expression: up to the end of its statement.
    const tail = src.slice(c.at, src.indexOf(";", c.at) + 1 || undefined);
    const close = c.args.length + tail.indexOf("[") + 1;
    const direct = /^\s*\][^)]*\)\s*\)?\s*\??\.out\b/.test(tail.slice(close));
    const uses: number[] = [];
    if (direct) uses.push(c.at);
    if (c.name) {
      const r = new RegExp(`\\b${c.name}\\s*\\??\\.out\\b`, "g");
      let u: RegExpExecArray | null;
      while ((u = r.exec(src))) if (u.index > c.at) uses.push(u.index);
    }
    if (!json && !wordsUnderTest)
      for (const at of uses)
        hits.push({
          line: lineAt(src, at),
          what: `reads the text output of cli([${c.args.trim()}]): pass --json and read its fields`,
        });
    // Names built from this call's output carry it on.
    for (const at of uses) {
      const stmtStart = src.lastIndexOf("\n", at) + 1;
      const stmt = src.slice(stmtStart, src.indexOf(";", at) + 1);
      const v = /(?:const|let|var)\s+([\w$]+)\s*=/.exec(stmt);
      if (v && !/JSON\.parse|\bparse\(/.test(stmt)) tainted.add(v[1]!);
      if (/\.(?:split|match)\(/.test(stmt.slice(at - stmtStart)))
        hits.push({
          line: lineAt(src, at),
          what: "splits or matches a command's printed output",
        });
    }
  }
  for (const name of tainted) {
    // name.split(…), or String(name).split(…) across a line break.
    const r = new RegExp(
      `(?:\\b${name}|\\bString\\(\\s*${name}\\s*\\))\\s*\\??\\.(?:split|match)\\(`,
      "g",
    );
    let u: RegExpExecArray | null;
    while ((u = r.exec(src)))
      hits.push({
        line: lineAt(src, u.index),
        what: `splits or matches ${name}, a command's printed output`,
      });
  }
  // One finding per line and kind.
  const seen = new Set<string>();
  return hits
    .filter((h) => {
      const k = `${h.line}:${h.what}`;
      return seen.has(k) ? false : (seen.add(k), true);
    })
    .sort((a, b) => a.line - b.line);
}

describe("issue 840: the checker, seen red first", () => {
  it("a text doctor read is flagged; the same read with --json is not", () => {
    const text = `export async function run(ctx) {
  const d = ctx.cli(["doctor"]);
  return { ok: /edge/.test(d.out) };
}`;
    expect(cliReads(text).map((h) => h.line)).toEqual([3]);
    const json = text.replace('["doctor"]', '["doctor", "--json"]');
    expect(cliReads(json)).toEqual([]);
  });

  it('flags .split(…)[n], .match(…)[n] and a split("\\n") loop over printed output, direct or through a variable', () => {
    const planted = `export async function run(ctx) {
  const a = ctx.cli(["agents", "accounts", "list"]).out.split(" ")[2];
  const b = ctx.cli(["edge", "route", "--for", "nginx"]);
  const host = b.out.match(/server_name (\\S+)/)[1];
  const d = ctx.cli(["doctor"]);
  const text = String(d.out + d.err);
  for (const l of text.split("\\n")) if (/push/.test(l)) return l;
  return { a, host };
}`;
    const lines = cliReads(planted).map((h) => h.line);
    expect(lines).toEqual(expect.arrayContaining([2, 4, 6, 7]));
  });

  it("an argument that indexes (LOOPS[0]) doesn't hide --json", () => {
    const src = `export async function run(ctx) {
  const c = await ctx.cli(["web", "url", LOOPS[0], "--json"]);
  return JSON.parse(c.out);
}`;
    expect(cliReads(src)).toEqual([]);
  });

  it("words under test may read the text whole, but never split or match it", () => {
    const whole = `export async function run(ctx) {
  const t = ctx.cli(["gate", "status"]);
  return { ok: String(t.out).includes("release priority") };
}`;
    expect(cliReads(whole, true)).toEqual([]);
    const wrapped = `export async function run(ctx) {
  const text = ctx.cli(["doctor"]).out ?? "";
  return String(text)
    .split("\\n")
    .find((l) => /Host/.test(l));
}`;
    expect(cliReads(wrapped, true).map((h) => h.line)).toEqual([3]);
    const byLine = `export async function run(ctx) {
  const t = ctx.cli(["gate", "status"]);
  const text = String(t.out);
  return text.split("\\n").find((l) => l.includes("x"));
}`;
    expect(cliReads(byLine, true).map((h) => h.line)).toEqual([4]);
  });

  it("a call read only for its exit code, or parsed as JSON, is not flagged", () => {
    const fine = `export async function run(ctx) {
  const down = ctx.cli(["web", "down", "--json"]).code;
  const up = (await ctx.cli(["web", "up", "--no-open"]))?.code ?? null;
  const d = JSON.parse(ctx.cli(["doctor", "--json"]).out);
  const l = ctx.cli(["agents", "accounts", "list", "--json"]);
  const rows = JSON.parse(l.out).accounts;
  return { down, up, d, rows };
}`;
    expect(cliReads(fine)).toEqual([]);
  });
});

/**
 * Live checks whose subject is the words a command prints (to a person, or
 * to an agent it refuses): they read the text, but whole (a contains or a
 * regex over all of it), never a line or a word by position.
 */
const WORDS_UNDER_TEST: Record<string, string> = {
  "441.mjs": "verify import's refusals: the words an agent is told",
  "715.mjs": "gate status shows a release priority's reason to a person",
  "731.mjs": "no secret in doctor's text, as a person reads it",
};

describe("issue 840: every live check reads Den's CLI through --json", () => {
  const files = fs
    .readdirSync(GATE)
    .filter((f) => /^\d+\.mjs$/.test(f))
    .sort((a, b) => parseInt(a) - parseInt(b));

  it("finds the live checks", () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it("no live check reads a command's text output, by field or by position", () => {
    const found: string[] = [];
    for (const f of files) {
      const src = fs.readFileSync(path.join(GATE, f), "utf-8");
      for (const h of cliReads(src, f in WORDS_UNDER_TEST))
        found.push(`gate/${f}:${h.line}: ${h.what}`);
    }
    expect(found).toEqual([]);
  });
});
