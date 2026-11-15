/**
 * Issue 163: "Ran while you were away". When the web server starts again
 * after it was down longer than a restart (ui.restart_wait_seconds, 90),
 * the agents that kept running in the meantime (their session outlived
 * it, as under Keep agents running after logout) and the ones restored
 * at this start are named in one bell note.
 *
 *   web-boots.json   each start; its stop time (stoppedAt) at any exit
 *   markInterrupted  says which agents kept running (`kept`)
 *   noteRanWhileAway the bell's one note
 *
 * A real host on a temp socket, a scripted PTY. Invented names only.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  CRASH_LOOP_DEFAULTS,
  markStopped,
  recordBoot,
  webAwayMs,
} from "../../../src/shared/crash-loop.js";
import { uiRestartWaitSeconds } from "../../../src/shared/den-config.js";
import { cmdAgents } from "../../../src/ui/cli/agents-command.js";
import {
  markInterrupted,
  resolveAgentsDeps,
} from "../../../src/ui/cli/agent-ops.js";
import { noteRanWhileAway } from "../../../src/ui/server/agent-routes.js";
import { cleanupRigs, rig } from "./helpers/rig.js";

afterEach(cleanupRigs);
const tmps: string[] = [];
afterEach(() => {
  for (const d of tmps.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});

describe("how long the web server was away", () => {
  it("from the last start's stop to this start; none when it never said it stopped", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-away-"));
    tmps.push(dir);
    const t0 = Date.parse("2026-11-15T08:00:00Z");
    recordBoot(dir, CRASH_LOOP_DEFAULTS, t0, 101);
    markStopped(dir, 101, t0 + 60_000);
    recordBoot(dir, CRASH_LOOP_DEFAULTS, t0 + 6 * 60_000, 202);
    expect(webAwayMs(dir, 202)).toBe(5 * 60_000);
    // 202 was killed: it never said when it stopped.
    recordBoot(dir, CRASH_LOOP_DEFAULTS, t0 + 9 * 60_000, 303);
    expect(webAwayMs(dir, 303)).toBeNull();
    // The very first start: nothing before it.
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "den-away-"));
    tmps.push(empty);
    recordBoot(empty, CRASH_LOOP_DEFAULTS, t0, 1);
    expect(webAwayMs(empty, 1)).toBeNull();
  });

  it("the note waits for an absence longer than a restart: ui.restart_wait_seconds (90)", () => {
    expect(uiRestartWaitSeconds(() => ({}))).toBe(90);
    expect(
      uiRestartWaitSeconds(() => ({ ui: { restart_wait_seconds: 30 } })),
    ).toBe(30);
  });
});

describe("which agents kept running", () => {
  it("a web-only restart: the host kept every session, so every running agent kept running", async () => {
    const r = await rig();
    const packs = path.join(r.dir, "personas");
    fs.mkdirSync(packs, { recursive: true });
    for (const id of ["planner", "helper"])
      fs.writeFileSync(
        path.join(packs, `${id}.md`),
        `---\nname: ${id}\n---\nYou work.\n`,
      );
    r.config.personaPacks = ["personas"];
    for (const id of ["planner", "helper"])
      expect(
        await cmdAgents(["start", "-w", "north", "--persona", id], r.deps),
      ).toBe(0);
    const found = await markInterrupted(resolveAgentsDeps(r.deps), {
      restoreAll: true,
    });
    expect(found.interrupted).toEqual([]);
    expect(found.kept.sort()).toEqual(["helper", "planner"]);
  }, 30_000);
});

describe("the bell's one note", () => {
  it("names who kept running and who came back; nothing when neither", () => {
    const added: Record<string, unknown>[] = [];
    const store = { add: (n: unknown) => (added.push(n as never), null) };
    noteRanWhileAway(store, ["planner", "helper"], ["writer"]);
    expect(added).toEqual([
      expect.objectContaining({
        kind: "service",
        subject: "record:agents-ran-while-away",
        text: "While Den was away, 2 kept running and 1 came back: planner, helper, writer",
        msg: {
          key: "bell.m.ranAway",
          vars: { kept: 2, back: 1, names: "planner, helper, writer" },
        },
        link: "/agents",
      }),
    ]);
    noteRanWhileAway(store, [], []);
    expect(added).toHaveLength(1);
  });
});
