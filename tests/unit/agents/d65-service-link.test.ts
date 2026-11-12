/**
 * D65 (D36): an agent's link to the services it works on is its own, on
 * its record, so it survives every restart path: stop and resume, Start
 * fresh, a persona change, Restart, and the API's start (Start agent
 * here). A person links and unlinks it (`agents link`, the API); an agent
 * can't.
 *
 * A real host on a temp socket, a scripted PTY (nothing runs). Invented
 * names only.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import { readRecord } from "../../../src/shared/agents/records.js";
import { cmdAgents } from "../../../src/ui/cli/agents-command.js";
import {
  changePersona,
  checkServiceList,
  resolveAgentsDeps,
  restartAgent,
  setAgentServices,
  startAgent,
  startFresh,
} from "../../../src/ui/cli/agent-ops.js";
import { cleanupRigs, rig, settle, type Rig } from "./helpers/rig.js";

afterEach(cleanupRigs);

const agents = (r: Rig, ...args: string[]) => cmdAgents(args, r.deps);
const services = (r: Rig, id = "planner") =>
  readRecord(r.stateDir, id)?.services;

/** Its PTY ends on TERM, as a real one does. */
function endOnTerm(r: Rig): void {
  r.deps.stopWaitMs = 3_000;
  const push = r.made.push.bind(r.made);
  r.made.push = (...ps) => {
    for (const p of ps) {
      const kill = p.kill.bind(p);
      p.kill = (sig: string) => {
        kill(sig);
        setTimeout(() => p.exit(143), 5);
      };
    }
    return push(...ps);
  };
}

/** A conversation whose last turn ended: idle, resumable. */
function idleTranscript(r: Rig, token: string): void {
  const claude = path.join(r.dir, "claude-config");
  const dir = path.join(claude, "projects", "-work");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${token}.jsonl`);
  fs.writeFileSync(
    file,
    [
      { type: "user", cwd: r.wsDir("north"), message: { content: "Plan" } },
      {
        type: "assistant",
        message: {
          stop_reason: "end_turn",
          content: [{ type: "text", text: "Planned." }],
        },
      },
    ]
      .map((x) => JSON.stringify(x))
      .join("\n") + "\n",
  );
  const t = new Date(Date.now() - 60_000);
  fs.utimesSync(file, t, t);
  r.deps.env = { ...r.deps.env, CLAUDE_CONFIG_DIR: claude };
}

async function linked(): Promise<Rig> {
  const r = await rig();
  endOnTerm(r);
  expect(await agents(r, "start", "-w", "north", "--persona", "planner")).toBe(
    0,
  );
  expect(await agents(r, "link", "planner", "notes", "shop/api")).toBe(0);
  expect(r.out.join("\n")).toContain("works on notes, shop/api");
  expect(services(r)).toEqual(["notes", "shop/api"]);
  idleTranscript(r, readRecord(r.stateDir, "planner")!.resumeToken!);
  return r;
}

describe("D65: link and unlink", () => {
  it("the CLI links, unlinks, and refuses a name that isn't a service's", async () => {
    const r = await linked();
    expect(await agents(r, "unlink", "planner", "notes")).toBe(0);
    expect(services(r)).toEqual(["shop/api"]);
    expect(await agents(r, "unlink", "planner", "shop/api")).toBe(0);
    expect(services(r)).toBeUndefined();
    expect(await agents(r, "link", "planner", "../etc")).toBe(2);
    expect(() => checkServiceList(["a/b/c"])).toThrow(/repo\/service/);
    expect(() => checkServiceList("notes")).toThrow();
  });
});

describe("D65: every restart path keeps the link", () => {
  it("stop, then resume", async () => {
    const r = await linked();
    expect(await agents(r, "stop", "planner")).toBe(0);
    await settle();
    expect(await agents(r, "resume", "planner")).toBe(0);
    expect(services(r)).toEqual(["notes", "shop/api"]);
  });

  it("Start fresh (a new conversation, as rotation and relaunch make)", async () => {
    const r = await linked();
    expect(await agents(r, "stop", "planner")).toBe(0);
    await settle();
    await startFresh(resolveAgentsDeps(r.deps), "planner");
    expect(r.made.length).toBeGreaterThan(1);
    expect(services(r)).toEqual(["notes", "shop/api"]);
  });

  it("a persona change", async () => {
    const r = await linked();
    await changePersona(resolveAgentsDeps(r.deps), "planner", "north", {
      persona: "reviewer",
      when: "now",
    });
    expect(readRecord(r.stateDir, "planner")?.persona).toBe("reviewer");
    expect(services(r)).toEqual(["notes", "shop/api"]);
  });

  it("Restart", async () => {
    const r = await linked();
    await restartAgent(resolveAgentsDeps(r.deps), "planner", "north", "now");
    expect(services(r)).toEqual(["notes", "shop/api"]);
  });

  it("a start with services (Start agent here) records them", async () => {
    const r = await rig();
    const s = await startAgent(resolveAgentsDeps(r.deps), {
      workspace: "north",
      persona: "planner",
      services: ["notes"],
    });
    expect(s.rec.services).toEqual(["notes"]);
    expect(services(r)).toEqual(["notes"]);
  });

  it("set and clear through the op", async () => {
    const r = await linked();
    const d = resolveAgentsDeps(r.deps);
    setAgentServices(d, "planner", "north", { add: ["blog"], remove: [] });
    expect(services(r)).toEqual(["notes", "shop/api", "blog"]);
    setAgentServices(d, "planner", "north", {
      add: [],
      remove: ["notes", "shop/api", "blog"],
    });
    expect(services(r)).toBeUndefined();
  });
});
