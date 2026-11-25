/**
 * Issue 1395: `gate settings --<key> <value>` run by an agent asks Den for
 * gate_settings_set (POST /api/approvals) with a reason, instead of being
 * refused; the CLI never writes settings.json itself for an agent. A
 * person's run is unchanged (POST /api/settings). A temp gates folder and
 * a fake server; invented names only.
 */
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { GateStore } from "../../../src/shared/gates/store.js";
import { cmdGate } from "../../../src/ui/cli/gate-command.js";
import type {
  PersonServer,
  ServerAnswer,
} from "../../../src/ui/cli/person-server.js";

let dir = "";
beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-1395-")));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

interface Call {
  method: string;
  path: string;
  body: unknown;
}

function rig(answer: ServerAnswer | null, env: NodeJS.ProcessEnv) {
  const calls: Call[] = [];
  const server: PersonServer = async (method, p, body) => {
    calls.push({ method, path: p, body });
    return answer;
  };
  const store = new GateStore({ dir, alive: () => true });
  const out: string[] = [];
  const err: string[] = [];
  const run = (...args: string[]) =>
    cmdGate(args, {
      store,
      env,
      server,
      out: (l) => out.push(l),
      err: (l) => err.push(l),
      now: Date.now,
      sleep: () => Promise.resolve(),
      exec: () => ({ pid: 1, kill: () => {}, done: Promise.resolve(0) }),
      every: () => () => {},
      onSignal: () => () => {},
      exit: () => {},
      pid: 4242,
      cwd: "/tmp/repo",
      lang: "en",
    });
  const file = () =>
    fs.existsSync(path.join(dir, "settings.json"))
      ? fs.readFileSync(path.join(dir, "settings.json"), "utf-8")
      : "";
  return { run, calls, out, err, store, file };
}

const AGENT = { DEN_AGENT: "agent:gate-tuner" };

describe("issue 1395: gate settings from an agent asks for gate_settings_set", () => {
  it("held: it asks with the patch and the reason, says it waits, and writes nothing", async () => {
    const g = rig(
      { status: 202, json: { state: "pending", id: "req-1" } },
      AGENT,
    );
    const before = g.file();
    expect(
      await g.run("settings", "--cpu-slots", "3", "--reason", "two runs wait"),
    ).toBe(0);
    expect(g.calls).toEqual([
      {
        method: "POST",
        path: "/api/approvals",
        body: {
          action: "gate_settings_set",
          args: { settings: { cpu_slots: 3 }, reason: "two runs wait" },
        },
      },
    ]);
    expect(g.out.join("\n")).toMatch(/Allow.*req-1/);
    expect(g.file()).toBe(before);
  });

  it("written at once: it says so", async () => {
    const g = rig(
      {
        status: 200,
        json: {
          state: "done",
          result: { ok: true, changed: ["gate.cpu_slots"] },
        },
      },
      AGENT,
    );
    expect(
      await g.run("settings", "--cpu-slots", "3", "--reason", "two runs wait"),
    ).toBe(0);
    expect(g.out.join("\n")).toContain("gate.cpu_slots");
  });

  it("no reason, a refusal, or no server: non-zero, and nothing is written", async () => {
    const none = rig(null, AGENT);
    const before = none.file();
    expect(await none.run("settings", "--cpu-slots", "3")).not.toBe(0);
    expect(none.calls).toEqual([]);
    expect(none.err.join("\n")).toMatch(/--reason/);
    expect(
      await none.run("settings", "--cpu-slots", "3", "--reason", "x"),
    ).not.toBe(0);
    expect(none.file()).toBe(before);
    const no = rig(
      { status: 400, json: { ok: false, error: "nothing to change" } },
      AGENT,
    );
    expect(
      await no.run("settings", "--cpu-slots", "3", "--reason", "x"),
    ).not.toBe(0);
    expect(no.err.join("\n")).toContain("nothing to change");
    const failed = rig(
      {
        status: 200,
        json: { state: "done", result: { ok: false, error: "busy" } },
      },
      AGENT,
    );
    expect(
      await failed.run("settings", "--cpu-slots", "3", "--reason", "x"),
    ).not.toBe(0);
    expect(failed.file()).toBe(before);
  });

  it("a person's run is unchanged: POST /api/settings", async () => {
    const g = rig({ status: 200, json: { ok: true } }, {});
    expect(await g.run("settings", "--cpu-slots", "3")).toBe(0);
    expect(g.calls.map((c) => c.path)).toEqual(["/api/settings"]);
  });
});
