/**
 * Issue 1223: an agent's Den tools (its MCP server, a child of its session)
 * keep the code of the Den they started on. After Den updates, that agent
 * is stale like one whose Hub tools changed: its row and pane say so with
 * Restart, doctor lists it, and restart-stale (the bell's Restart N agents)
 * counts it. Den stamps the version it starts an agent on; an agent
 * started before the stamp is judged by the last update's time.
 *
 * A real host on a temp socket with a scripted PTY: nothing runs. Invented
 * names only.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { denToolsOld } from "../../../src/shared/agents/den-tools-version.js";
import { readRecord, writeRecord } from "../../../src/shared/agents/records.js";
import { engineVersion } from "../../../src/shared/paths.js";
import { cmdAgents, staleLines } from "../../../src/ui/cli/agents-command.js";
import {
  listAgents,
  resolveAgentsDeps,
  staleAgents,
} from "../../../src/ui/cli/agent-ops.js";
import { listedSessions } from "../../../src/ui/server/session-routes.js";
import { cleanupRigs, rig, type Rig } from "./helpers/rig.js";

afterEach(async () => {
  await cleanupRigs();
});

const agents = (r: Rig, ...args: string[]) => cmdAgents(args, r.deps);
const NOW = engineVersion()!;
const OLD = "0.0.1-old";

function updateState(stateDir: string, s: object): void {
  const dir = path.join(stateDir, "server-agent", "update");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify(s));
}

describe("issue 1223: denToolsOld, the Den an agent's tools started on", () => {
  const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), "den-1223-"));
  const at = "2026-11-20T10:00:00.000Z";

  it("stamped older than the installed Den: old, from → to; the same: not", () => {
    const s = dir();
    expect(denToolsOld({ denVersion: "0.4.84" }, at, s, "0.4.85")).toEqual({
      from: "0.4.84",
      to: "0.4.85",
    });
    expect(denToolsOld({ denVersion: "0.4.85" }, at, s, "0.4.85")).toBe(
      undefined,
    );
    // Nothing known of the installed Den: never stale.
    expect(denToolsOld({ denVersion: "0.4.84" }, at, s, null)).toBe(undefined);
  });

  it("no stamp (started before 0.4.86): an update to this Den after it started makes it old", () => {
    const s = dir();
    expect(denToolsOld({}, at, s, "0.4.85")).toBe(undefined);
    updateState(s, {
      state: "good",
      from: "0.4.84",
      to: "0.4.85",
      at: "2026-11-21T10:00:00.000Z",
    });
    expect(denToolsOld({}, at, s, "0.4.85")).toEqual({
      from: "0.4.84",
      to: "0.4.85",
    });
    // Started after that update: its tools are this Den's.
    expect(denToolsOld({}, "2026-11-22T10:00:00.000Z", s, "0.4.85")).toBe(
      undefined,
    );
    // An update to another version than the one installed: not this one.
    expect(denToolsOld({}, at, s, "0.4.86")).toBe(undefined);
  });
});

describe("issue 1223: a running agent on an older Den's tools is stale", () => {
  async function started(): Promise<Rig> {
    const r = await rig();
    expect(
      await agents(r, "start", "-w", "north", "--persona", "planner"),
    ).toBe(0);
    return r;
  }
  const age = (r: Rig, v: string) => {
    const rec = readRecord(r.stateDir, "planner")!;
    writeRecord(r.stateDir, { ...rec, denVersion: v });
  };

  it("Den stamps the version it starts an agent on", async () => {
    const r = await started();
    expect(readRecord(r.stateDir, "planner")?.denVersion).toBe(NOW);
  });

  it("its row, staleAgents and doctor say its Den tools are older; on this Den's, nothing", async () => {
    const r = await started();
    const d = resolveAgentsDeps(r.deps);
    expect(await staleAgents(d, { fresh: true })).toEqual([]);
    age(r, OLD);
    const den = { from: OLD, to: NOW };
    expect(await staleAgents(d, { fresh: true })).toEqual([
      {
        id: "planner",
        workspace: "north",
        stale: { adds: [], drops: [], den },
      },
    ]);
    const row = (await listAgents(d, "north")).find(
      (x) => x.agent === "planner",
    )!;
    expect(row.mcpStale).toEqual({ adds: [], drops: [], den });
    expect(
      staleLines(await staleAgents(d, { fresh: true }), "acme").join("\n"),
    ).toContain(
      `  planner (north): its Den tools are ${OLD}'s; ${NOW}'s arrive on restart`,
    );
  });

  it("the Agents page's list (/api/sessions) carries it while running, not once stopped", async () => {
    const r = await started();
    age(r, OLD);
    const c = await r.deps.connect!();
    const sessions = await c.list();
    c.close();
    const d = {
      stateDir: () => r.stateDir,
      dist: () => "acme",
      activeWorkspaces: () => ["north"],
    };
    const row = (s: typeof sessions) =>
      listedSessions(s, d, undefined, null).find((x) => x.agent === "planner")!;
    expect(row(sessions).mcpStale).toEqual({
      adds: [],
      drops: [],
      den: { from: OLD, to: NOW },
    });
    const stopped = sessions.map((x) => ({ ...x, exited: true, exitCode: 0 }));
    expect(row(stopped).mcpStale).toBeUndefined();
  });
});

// Settings' Hub section offers to restart the Hub-stale only: its words
// are about Hub (an older Den's tools are the bell's, part B).
import { restartOfferHtml } from "../../../src/ui/server/public/settings-registry.js";

describe("issue 1223: Settings' Hub restart offer counts Hub's stale agents only", () => {
  const den = { from: OLD, to: NOW };
  it("only an older Den's tools: no Hub offer", () => {
    expect(
      restartOfferHtml([
        { id: "a", workspace: "north", stale: { adds: [], drops: [], den } },
      ]),
    ).toBe("");
  });
  it("mixed: counts the Hub ones, and its button restarts only those", () => {
    const html = restartOfferHtml([
      { id: "a", workspace: "north", stale: { adds: [], drops: [], den } },
      { id: "b", workspace: "north", stale: { adds: ["hub"], drops: [] } },
    ]);
    expect(html).toContain('data-hub-restart="1"');
    expect(html).toContain("1 agent started before Hub was connected");
  });
});
