/**
 * Issue 845, clause 2: a live check that only reads Den's state says so with
 * `export const readOnly = true;`. The bed runs those together (a few at a
 * time, each in its own browser context, inside one test slot), so one that
 * writes would change what the others see. This test reads the source of
 * every gate/<issue>.mjs marked readOnly and fails on any call that writes:
 * a write request, a CLI command that is not a known read, the stub agent,
 * the edge or address, Hub writes, a second Den, files, child processes,
 * a faked route or a sign-out. CONTRIBUTING.md, "Live checks", says what
 * readOnly means.
 */
import { describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";

const ROOT = path.resolve(__dirname, "../../..");
const GATE = path.join(ROOT, "gate");

/** CLI commands that only read, by their leading words. */
const READ_CLI = [
  ["doctor"],
  ["agents", "list"],
  ["agents", "accounts", "list"],
  ["edge", "route"],
  ["edge", "routes"],
  ["edge", "status"],
  ["gate", "status"],
  ["web", "status"],
];

/** [what, pattern]: any match in a readOnly module is a write. */
const WRITES: Array<[string, RegExp]> = [
  [
    "a write request (method other than GET or HEAD)",
    /\bmethod\s*:\s*["'`](?!(?:GET|HEAD)["'`])\w+/g,
  ],
  ["a request whose method is a variable", /[{,]\s*method\s*(?=[,}])/g],
  [
    "a write through the page's API helper",
    /\bapi\(\s*["'`](?:POST|PUT|PATCH|DELETE)\b/g,
  ],
  ["a CLI call whose arguments are not a literal list", /\bcli\(\s*(?!\[)/g],
  ["the stub agent (start, stop, remove, ask, ...)", /\bctx\.agent\b/g],
  ["the stub runtime's next start or trust", /\bctx\.stub\.(?!log\b)\w+/g],
  ["the bed's edge (swap, restore)", /\bctx\.edge\.(?:swap|restore)\b/g],
  ["taking the address down", /\bctx\.addressDead\b/g],
  ["a second Den", /\bctx\.den2\b/g],
  ["a Hub connect", /\bctx\.hubConnect\b/g],
  ["a user.yml change", /\bctx\.userYml\b/g],
  ["a sign-in link or pairing code", /\bctx\.(?:loginLink|pairing)\b/g],
  [
    "a Hub write (comment or doc)",
    /\bctx\.hubs?\b[\w.?[\]'"]*\.(?:comment|doc)\(/g,
  ],
  ["a sign-out", /\/api\/session\/logout\b|\bsignOut\(/g],
  [
    "a file write",
    /\b(?:writeFileSync|writeFile|appendFileSync|appendFile|mkdirSync|mkdtempSync|mkdir|rmSync|rm|unlinkSync|unlink|renameSync|rename|copyFileSync|symlinkSync|chmodSync)\(/g,
  ],
  [
    "a child process",
    /\b(?:execFileSync|execFile|execSync|spawnSync|spawn|fork)\(|\bchild_process\b/g,
  ],
  ["a faked request (page.route stands in for a write)", /\.route\(/g],
  ["a restart", /\.restart\(|\bden_restart_server\b/g],
];

/** The source without comments, so prose about writes never counts. */
function code(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[\s;,{}()])\/\/[^\n]*/g, "$1");
}

/** Every write call in a module's source, as "line N: what (`text`)". */
function writesIn(src: string): string[] {
  const text = code(src);
  const lineOf = (i: number) => text.slice(0, i).split("\n").length;
  const out: Array<[number, string]> = [];
  for (const [what, re] of WRITES)
    for (const m of text.matchAll(re))
      out.push([lineOf(m.index ?? 0), `${what} (\`${m[0].trim()}\`)`]);
  // Each literal CLI call: its leading words must be a known read.
  for (const m of text.matchAll(/\bcli\(\s*\[([^\]]*)\]/g)) {
    const words = [...m[1].matchAll(/["'`]([^"'`]*)["'`]/g)].map((w) => w[1]);
    const read = READ_CLI.some((r) => r.every((w, i) => words[i] === w));
    if (!read)
      out.push([
        lineOf(m.index ?? 0),
        `a CLI command that is not a known read (\`${words.join(" ")}\`)`,
      ]);
  }
  return out.sort((a, b) => a[0] - b[0]).map(([l, w]) => `line ${l}: ${w}`);
}

const READ_ONLY = /^export const readOnly = true;/m;

function modules(): Array<{ file: string; src: string }> {
  return fs
    .readdirSync(GATE)
    .filter((f) => /^\d+\.mjs$/.test(f))
    .sort((a, b) => parseInt(a, 10) - parseInt(b, 10))
    .map((file) => ({
      file,
      src: fs.readFileSync(path.join(GATE, file), "utf-8"),
    }));
}

describe("live checks marked readOnly write nothing (issue 845)", () => {
  it("finds each kind of write", () => {
    const planted = [
      `await ctx.api("/api/settings", { method: "POST", body: "{}" });`,
      `await ctx.fetch(p, { method });`,
      `await window.denShell.api("PUT", p, b);`,
      `ctx.cli(args);`,
      `ctx.cli(["agents", "stop", "x"]);`,
      `ctx.cli(["web", "down", "--json"]);`,
      `ctx.cli(["config", "set", "a=b"]);`,
      `ctx.cli(["gate", "run", "--kind", "browser"]);`,
      `ctx.cli(["hub", "link", "-p", "x"]);`,
      `const a = ctx.agent("gate-1");`,
      `ctx.stub.nextStart({ mode: "trust" });`,
      `await ctx.edge.swap({ image });`,
      `await ctx.addressDead({ keepSeconds: 5 });`,
      `const d2 = await ctx.den2();`,
      `await ctx.hubConnect("a");`,
      `ctx.userYml({ ui: {} });`,
      `const l = ctx.loginLink();`,
      `await ctx.hub.comment({ agent, text });`,
      `await ctx.hubs.a.doc({ agent });`,
      `await fetch(new URL("/api/session/logout", ctx.hostUrl));`,
      `fs.writeFileSync(f, "");`,
      `execFileSync("sh", ["-c", "true"]);`,
      `await page.route("**/api/x", fake);`,
      `await a.restart();`,
    ];
    const missed = planted.filter((s) => writesIn(s).length === 0);
    expect(missed).toEqual([]);
  });

  it("lets reads through", () => {
    const reads = [
      `await ctx.api("/api/settings");`,
      `await ctx.fetch("/api/x", { method: "GET" });`,
      `ctx.cli(["doctor", "--json"]);`,
      `ctx.cli(["agents", "accounts", "list"]);`,
      `ctx.cli(["edge", "route", "--for", kind]);`,
      `ctx.readBed("state:host-refresh.json");`,
      `await ctx.goto(ctx.page, "/settings"); await ctx.shot("x");`,
      `// ctx.cli(["web", "down"]) is never run here`,
      `/* fs.writeFileSync(x) */ const u = "https://x.invalid/a";`,
      `r.request().method() === "GET"`,
    ];
    expect(reads.flatMap((s) => writesIn(s).map((w) => `${s} → ${w}`))).toEqual(
      [],
    );
  });

  it("some modules are marked readOnly", () => {
    expect(
      modules().filter((m) => READ_ONLY.test(m.src)).length,
    ).toBeGreaterThan(0);
  });

  it("no readOnly module writes", () => {
    const bad = modules()
      .filter((m) => READ_ONLY.test(m.src))
      .flatMap((m) => writesIn(m.src).map((w) => `gate/${m.file}: ${w}`));
    expect(bad).toEqual([]);
  });

  it("readOnly is only ever `export const readOnly = true;`", () => {
    // Anything else (false, a variable, another spelling) the bed reads as
    // not read-only, but this test would not check it: say it plainly.
    const odd = modules()
      .filter(
        (m) => /\breadOnly\b\s*=/.test(code(m.src)) && !READ_ONLY.test(m.src),
      )
      .map((m) => m.file);
    expect(odd).toEqual([]);
  });
});
