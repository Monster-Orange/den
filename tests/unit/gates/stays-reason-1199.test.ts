/**
 * Issue 1199, clause 4: every browser waiter that won't go to a test box
 * has a stored reason, which gate status, the gate page and the slot log
 * show. Before, a run asked with --box local, with browser_box_default
 * local, or over MCP stayed here with no reason anywhere.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { GateStore } from "../../../src/shared/gates/store.js";
import { cmdGate, type GateDeps } from "../../../src/ui/cli/gate-command.js";
import type { DenApi } from "../../../src/ui/mcp/api.js";
import { callTool, type ToolContext } from "../../../src/ui/mcp/tools.js";

const ROOT = path.resolve(__dirname, "../../..");
const tmps: string[] = [];
afterEach(() => {
  for (const d of tmps.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});

const T0 = Date.parse("2026-11-22T12:00:00Z");

function storeWithBox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-gate1199s-"));
  tmps.push(dir);
  const store = new GateStore({
    platform: "linux",
    dir,
    alive: () => true,
    now: () => T0,
    probe: () => Promise.resolve({ state: "open" }),
  });
  store.setBox({
    name: "b1",
    ssh: "ci@b1.test",
    playwright: "ws://b1.test:3000",
    playwright_version: "1.48.0",
  });
  // This machine's browser slot is held, so the next run waits.
  store.ask({
    kind: "browser",
    who: "other",
    label: "held",
    pid: 1,
    estimateMin: 10,
  });
  return store;
}

function deps(store: GateStore) {
  const out: string[] = [];
  const err: string[] = [];
  let waits = 0;
  const d: GateDeps = {
    store,
    env: {},
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    now: () => T0,
    sleep: async () => {
      if (++waits === 1) await cmdGate(["status"], d);
      if (waits > 3) throw new Error("stop waiting");
    },
    exec: () => ({ pid: 1, kill: () => {}, done: Promise.resolve(0) }),
    every: () => () => {},
    onSignal: () => () => {},
    exit: () => {},
    pid: 4242,
    cwd: "/x/repo",
  };
  return { d, out, err };
}

const run = (more: string[]) => [
  "run",
  "--kind",
  "browser",
  "--label",
  "e2e",
  "--pw-version",
  "1.48.0",
  "--base-url",
  "http://den.localhost:4100",
  ...more,
  "--",
  "npm",
  "test",
];

const waiter = (s: GateStore) => s.list().find((e) => e.label === "e2e")!;
const askedRow = (s: GateStore) =>
  s.events().find((r) => r.event === "asked" && r.label === "e2e") as
    | Record<string, unknown>
    | undefined;

describe("issue 1199: a waiter that stays here always says why", () => {
  it("--box local: stored, in gate status and in the slot log's asked row", async () => {
    const s = storeWithBox();
    const t = deps(s);
    let seen: string | undefined;
    t.d.sleep = async () => {
      seen ??= waiter(s).hostWhy;
      await cmdGate(["status"], t.d);
      throw new Error("stop waiting");
    };
    await cmdGate(run(["--box", "local"]), t.d);
    expect(seen).toMatch(/--box local/);
    expect(t.out.join("\n")).toMatch(/stays here: .*--box local/);
    expect(askedRow(s)?.hostWhy).toMatch(/--box local/);
  });

  it("browser_box_default local: stored, and says so", async () => {
    const s = storeWithBox();
    s.writeSettings({ browser_box_default: "local" }, "a test");
    const t = deps(s);
    let seen: string | undefined;
    t.d.sleep = async () => {
      seen ??= waiter(s).hostWhy;
      throw new Error("stop waiting");
    };
    await cmdGate(run([]), t.d);
    expect(seen).toMatch(/browser_box_default local/);
    expect(askedRow(s)?.hostWhy).toMatch(/browser_box_default local/);
  });

  it("a browser slot asked over MCP: stored, and says so", async () => {
    const s = storeWithBox();
    const ctx: ToolContext = {
      api: {
        baseUrl: "http://localhost:47003",
        async get(p: string) {
          if (p === "/api/workspaces")
            return { active: ["north"], workspaces: { north: {} } };
          throw new Error(`no API call expected: ${p}`);
        },
      } as unknown as DenApi,
      cfg: {
        actions: [],
        runTestsEnvs: ["local"],
        logsRemote: false,
        approvals: true,
      } as unknown as ToolContext["cfg"],
      cli: "acme",
      scope: { workspace: "north", actor: "agent:coder" },
      gates: s,
    };
    const r = await callTool(
      "gate_slot_request",
      { kind: "browser", label: "e2e", estimate_minutes: 5 },
      ctx,
    );
    expect(JSON.parse(r.text)).toMatchObject({
      kind: "browser",
      granted: false,
    });
    expect(waiter(s).hostWhy).toMatch(/over MCP/);
    expect(askedRow(s)?.hostWhy).toMatch(/over MCP/);
  });

  it("the gate page shows it, in en, es and ja", () => {
    const chip = fs.readFileSync(
      path.join(ROOT, "src/ui/server/public/gate-chip.js"),
      "utf-8",
    );
    expect(chip).toMatch(/t\("gate\.staysHere", \{ why: s\.hostWhy \}\)/);
    for (const f of ["shell.js", "i18n/es.js", "i18n/ja.js"]) {
      const words = fs.readFileSync(
        path.join(ROOT, "src/ui/server/public", f),
        "utf-8",
      );
      expect(words).toMatch(/"gate\.staysHere":\s*"[^"]*\{why\}/);
    }
  });
});
