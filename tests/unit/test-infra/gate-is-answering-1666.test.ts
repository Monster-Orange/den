import { beforeAll, describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

const GATE = path.join(process.cwd(), "gate");
const MOD = path.join(GATE, "lib", "answering.mjs");

const SCRIPT = `
import * as http from "node:http";
const { isAnswering } = await import(${JSON.stringify(MOD)});
const listen = (handler) =>
  new Promise((ok) => {
    const s = http.createServer(handler);
    s.listen(0, "127.0.0.1", () => ok(s));
  });
const den = await listen((q, r) => {
  r.setHeader("content-type", "application/json");
  r.end(JSON.stringify({ groups: [], updates: [] }));
});
const proxy = await listen((q, r) => {
  r.statusCode = 502;
  r.end("Bad Gateway");
});
const reset = await listen((q) => q.socket.destroy());
const base = (s) => "http://127.0.0.1:" + s.address().port;
const parsed = (b) => ({
  api: async (p) => {
    const r = await fetch(b + p);
    const t = await r.text();
    try {
      return JSON.parse(t);
    } catch {
      return { status: r.status, text: t };
    }
  },
});
const asResponse = (b) => ({ api: (p) => fetch(b + p) });
const out = {
  refused: await isAnswering(parsed("http://127.0.0.1:1")),
  reset: await isAnswering(parsed(base(reset))),
  errorPage: await isAnswering(parsed(base(proxy))),
  den: await isAnswering(parsed(base(den))),
  denResponse: await isAnswering(asResponse(base(den))),
  errorResponse: await isAnswering(asResponse(base(proxy))),
};
for (const s of [den, proxy, reset]) s.close();
console.log(JSON.stringify(out));
`;

let out: Record<string, unknown>;
let err = "";
beforeAll(() => {
  const p = spawnSync(process.execPath, ["--input-type=module", "-e", SCRIPT], {
    encoding: "utf-8",
    timeout: 30_000,
  });
  err = p.stderr;
  out = p.status === 0 ? JSON.parse(p.stdout.trim().split("\n").pop()!) : {};
});

describe("isAnswering (issue 1666)", () => {
  it("a refused connection is not answering, never a throw", () => {
    expect(err).toBe("");
    expect(out.refused).toBe(false);
  });

  it("a reset connection is not answering", () => {
    expect(out.reset).toBe(false);
  });

  it("an error page while Den restarts is not answering", () => {
    expect(out.errorPage).toBe(false);
    expect(out.errorResponse).toBe(false);
  });

  it("Den's notifications answer is answering, parsed or as a Response", () => {
    expect(out.den).toBe(true);
    expect(out.denResponse).toBe(true);
  });
});

describe("the checks that restart Den use it", () => {
  const checks = fs
    .readdirSync(GATE)
    .filter((f) => /^\d+\.mjs$/.test(f))
    .map((f) => [f, fs.readFileSync(path.join(GATE, f), "utf-8")] as const);

  it("no live check keeps its own answering probe", () => {
    const own = checks
      .filter(([, s]) => /(const|function)\s+answering\b/.test(s))
      .map(([f]) => f);
    expect(own).toEqual([]);
  });

  it.each(["369.mjs", "459.mjs", "609.mjs", "629.mjs", "828.mjs"])(
    "%s imports isAnswering from ./lib/answering.mjs",
    (f) => {
      const s = checks.find(([n]) => n === f)?.[1] ?? "";
      expect(s).toMatch(
        /import\s*\{[^}]*\bisAnswering\b[^}]*\}\s*from\s*["']\.\/lib\/answering\.mjs["']/,
      );
    },
  );
});
