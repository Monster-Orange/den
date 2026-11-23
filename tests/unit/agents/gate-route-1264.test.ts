/**
 * Issue 1264: a test, typecheck or browser run an agent starts outside the
 * gate goes through it. Den's PreToolUse hook rewrites such a Bash command
 * to run under `gate run` (cpu, or browser for Playwright), and gives jest
 * and vitest the gate's worker share when the command names none, so no
 * run starts cores − 1 workers. A command it isn't sure of stays as it is.
 * Pure: routeCommand (guardrails/gate-route.mjs) with the hook's parser.
 */
import { describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";
import * as path from "path";

const RUN = path.resolve("tests/unit/agents/gate-route-run.mjs");

interface Routed {
  command: string;
  kind: "cpu" | "browser";
  program: string;
}
interface Case {
  command: string;
  gate?: string;
  programs?: readonly string[];
  badParse?: boolean;
}

/** routeCommand for these cases, in one node process (it's an .mjs). */
function call(cases: Case[]): {
  results: (Routed | null)[];
  ROUTE_DEFAULT: string[];
  WORKERS_FLAG: string;
} {
  const r = spawnSync(process.execPath, [RUN], {
    input: JSON.stringify(cases),
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(r.stderr);
  return JSON.parse(r.stdout);
}

const { ROUTE_DEFAULT, WORKERS_FLAG } = call([]);

const GATE = "'/opt/den/bin/den' gate run";
const route = (command: string, programs?: readonly string[]): Routed | null =>
  call([{ command, gate: GATE, programs }]).results[0];

/** The command a rewrite runs inside the gate (bash -c '<this>'). */
function inner(rewritten: string): string {
  const m = /-- bash -c '(.*)'$/s.exec(rewritten);
  expect(m).not.toBeNull();
  return m![1]!.replace(/'\\''/g, "'");
}

describe("issue 1264: heavy runs an agent starts go through the gate", () => {
  it("npx jest is a gated cpu run, with the gate's worker share", () => {
    const r = route("npx jest tests/unit/a.test.ts");
    expect(r).toMatchObject({ kind: "cpu", program: "jest" });
    expect(r!.command.startsWith(`${GATE} --kind cpu --label `)).toBe(true);
    expect(inner(r!.command)).toBe(
      `npx jest ${WORKERS_FLAG} tests/unit/a.test.ts`,
    );
  });

  it("the worker flag uses the gate's DEN_GATE_WORKERS, one when it's unset", () => {
    expect(WORKERS_FLAG).toBe("--maxWorkers=${DEN_GATE_WORKERS:-1}");
  });

  it("npx playwright test is a gated browser run, its workers left to it", () => {
    const r = route("npx playwright test e2e/a.spec.ts");
    expect(r).toMatchObject({ kind: "browser", program: "playwright" });
    expect(inner(r!.command)).toBe("npx playwright test e2e/a.spec.ts");
  });

  it("vitest run and tsc are gated cpu runs; tsc gets no worker flag", () => {
    expect(inner(route("vitest run src")!.command)).toBe(
      `vitest ${WORKERS_FLAG} run src`,
    );
    const t = route("npx tsc --noEmit -p .");
    expect(t).toMatchObject({ kind: "cpu", program: "tsc" });
    expect(inner(t!.command)).toBe("npx tsc --noEmit -p .");
  });

  it("npm test and npm run test:unit are gated, with no flag (the script may not be jest)", () => {
    expect(route("npm test")).toMatchObject({ program: "npm test" });
    expect(inner(route("npm test")!.command)).toBe("npm test");
    expect(route("npm run test:unit")).toMatchObject({
      program: "npm run test*",
    });
    expect(route("npm run lint")).toBeNull();
  });

  it("a worker count the command sets is kept, never doubled", () => {
    for (const c of [
      "npx jest --maxWorkers=1 a.test.ts",
      "npx jest -w 2 a.test.ts",
      "npx jest -i a.test.ts",
      "npx jest --runInBand a.test.ts",
      "npx vitest run --max-workers=2",
    ])
      expect(inner(route(c)!.command)).toBe(c);
  });

  it("the whole command line runs in the gate: cd, &&, pipes and quotes kept", () => {
    const c = `cd /w/den && npx jest a.test.ts 2>&1 | grep -E "✕|Tests:"`;
    expect(inner(route(c)!.command)).toBe(
      `cd /w/den && npx jest ${WORKERS_FLAG} a.test.ts 2>&1 | grep -E "✕|Tests:"`,
    );
    const q = `npx jest -t 'it'"'"'s red' a.test.ts`;
    expect(inner(route(q)!.command)).toBe(
      `npx jest ${WORKERS_FLAG} -t 'it'"'"'s red' a.test.ts`,
    );
  });

  it("already gated (lair gate run, den gate run) is not wrapped twice", () => {
    expect(route("lair gate run --kind cpu -- npx jest a.test.ts")).toBeNull();
    expect(
      route("/x/mo-lair/bin/lair gate run -- npx jest a.test.ts"),
    ).toBeNull();
    expect(route(`${GATE} --kind cpu -- npx jest a.test.ts`)).toBeNull();
  });

  it("a command with no heavy program is left alone", () => {
    for (const c of ["git status", "ls tests", "echo jest", "grep -n jest x"])
      expect(route(c)).toBeNull();
  });

  it("the program word twice: gated, but no flag (where it goes isn't sure)", () => {
    const c = "npx jest a.test.ts && npx jest b.test.ts";
    expect(inner(route(c)!.command)).toBe(c);
  });

  it("off (no list) or an empty list: nothing is rewritten", () => {
    expect(route("npx jest a.test.ts", [])).toBeNull();
    expect(
      call([{ command: "npx jest a.test.ts", gate: "" }]).results[0],
    ).toBeNull();
  });

  it("the list is the setting's: only what it names is routed", () => {
    expect(route("npx tsc -p .", ["jest"])).toBeNull();
    expect(route("npx jest a.test.ts", ["jest"])).toMatchObject({
      program: "jest",
    });
  });

  it("the default list is the issue's: jest, vitest, tsc, playwright, npm test, npm run test*", () => {
    expect([...ROUTE_DEFAULT]).toEqual([
      "jest",
      "vitest",
      "tsc",
      "playwright",
      "npm test",
      "npm run test*",
    ]);
  });

  it("a command the parser can't read is left alone", () => {
    expect(
      call([{ command: "npx jest a", gate: GATE, badParse: true }]).results[0],
    ).toBeNull();
  });
});
