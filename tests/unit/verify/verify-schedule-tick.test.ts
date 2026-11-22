/**
 * Issue 214 (T18, the loop's choice): when a schedule's run is due, Den runs
 * it in its window, under its standing Allow; without one it skips it,
 * named, and never runs it unallowed. Times are local.
 */
import { describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { VerifyModule } from "../../../src/shared/verify/config.js";
import {
  listSchedules,
  writeAllow,
  SCHEDULE_DEFAULTS,
  type Schedule,
} from "../../../src/shared/verify/schedules.js";
import {
  decide,
  readScheduleRuns,
  noteScheduleRun,
} from "../../../src/shared/verify/schedule-tick.js";

// A repo with the script the scheduled commands run (Den follows only a
// command whose files it can find).
const REPO = fs.mkdtempSync(path.join(os.tmpdir(), "den-sched-repo-"));
fs.mkdirSync(path.join(REPO, "scripts"));
fs.writeFileSync(path.join(REPO, "scripts/speed.sh"), "echo ok\n");
// Commands on a shared environment: on (off is Den's default; its own tests).
const ON = { ...SCHEDULE_DEFAULTS, sharedCommands: true };
const at = (d: number, h: number, mi = 0) => new Date(2026, 10, d, h, mi);
const DAY = 86_400_000;

function mod(
  name: string,
  env: string,
  over: Partial<VerifyModule> = {},
): VerifyModule {
  return {
    id: `shop:${name}`,
    repo: "shop",
    repoPath: REPO,
    name,
    layer: name.split("/")[0],
    kind: "performance",
    adapter: "cmd",
    mark: "declared-read-only",
    environments: [env],
    cmd: "./scripts/speed.sh",
    writes: false,
    healthUrls: {},
    schedule: { cron: "0 2 * * *", window: "01:00-05:00", env },
    ...over,
  };
}

const staging: Schedule = listSchedules("shop", [
  mod("web/speed", "staging"),
])[0];
const local: Schedule = listSchedules("shop", [mod("web/speed", "local")])[0];
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "den-tick-"));

describe("decide", () => {
  it("schedule Allow scope: a command on a shared environment is skipped by default (commands-off), even when allowed", () => {
    const r = { lastDue: at(21, 3).toISOString() };
    const a = writeAllow(
      tmp(),
      "shop",
      staging,
      { kind: "person" },
      at(21, 12),
      SCHEDULE_DEFAULTS,
    );
    expect(
      decide(staging, a, r, at(22, 2, 1), SCHEDULE_DEFAULTS),
    ).toMatchObject({
      action: "skip",
      reason: "commands-off",
    });
    // Local is the person's own machine: no limit there.
    expect(
      decide(local, undefined, r, at(22, 2, 1), SCHEDULE_DEFAULTS).action,
    ).toBe("run");
  });

  it("schedule Allow scope: with commands on, one Den can't follow is skipped (command-unclear)", () => {
    const r = { lastDue: at(21, 3).toISOString() };
    for (const cmd of [
      "make speed",
      "npm run speed",
      "cd scripts && sh speed.sh",
      "python -m tool",
      "sh -c ./scripts/speed.sh",
      "./scripts/gone.sh",
      "./scripts/speed.sh > out.txt",
      "FOO=1 ./scripts/speed.sh",
      "bash scripts/speed.sh $HOME",
    ]) {
      const s = listSchedules("shop", [
        mod("web/speed", "staging", { cmd }),
      ])[0];
      const a = writeAllow(
        tmp(),
        "shop",
        s,
        { kind: "person" },
        at(21, 12),
        ON,
      );
      expect([cmd, decide(s, a, r, at(22, 2, 1), ON)]).toMatchObject([
        cmd,
        { action: "skip", reason: "command-unclear" },
      ]);
    }
    for (const cmd of [
      "./scripts/speed.sh --quick",
      "bash scripts/speed.sh && ./scripts/speed.sh",
    ]) {
      const s = listSchedules("shop", [
        mod("web/speed", "staging", { cmd }),
      ])[0];
      const a = writeAllow(
        tmp(),
        "shop",
        s,
        { kind: "person" },
        at(21, 12),
        ON,
      );
      expect([cmd, decide(s, a, r, at(22, 2, 1), ON).action]).toEqual([
        cmd,
        "run",
      ]);
    }
  });

  it("first sight: a baseline, so nothing runs for times before Den saw it", () => {
    expect(decide(local, undefined, {}, at(21, 3), ON)).toEqual({
      action: "baseline",
    });
  });

  it("not due yet: wait", () => {
    expect(
      decide(
        local,
        undefined,
        { lastDue: at(21, 3).toISOString() },
        at(21, 23),
        ON,
      ),
    ).toEqual({ action: "wait" });
  });

  it("due, in its window, no Allow needed: run", () => {
    expect(
      decide(
        local,
        undefined,
        { lastDue: at(21, 3).toISOString() },
        at(22, 2, 1),
        ON,
      ),
    ).toEqual({ action: "run", due: at(22, 2).toISOString() });
  });

  it("due before its window opens: wait for the window", () => {
    const s = listSchedules("shop", [
      mod("web/speed", "local", {
        schedule: { cron: "0 0 * * *", window: "01:00-05:00", env: "local" },
      }),
    ])[0];
    const r = { lastDue: at(21, 6).toISOString() };
    expect(decide(s, undefined, r, at(22, 0, 30), ON)).toEqual({
      action: "wait",
    });
    expect(decide(s, undefined, r, at(22, 1, 0), ON)).toEqual({
      action: "run",
      due: at(22, 0).toISOString(),
    });
  });

  it("the window closed before it could start: missed, named", () => {
    expect(
      decide(
        local,
        undefined,
        { lastDue: at(21, 3).toISOString() },
        at(22, 5, 0),
        ON,
      ),
    ).toEqual({
      action: "skip",
      due: at(22, 2).toISOString(),
      reason: "window",
    });
  });

  it("shared, no Allow: skipped, never run unallowed (T18)", () => {
    expect(
      decide(
        staging,
        undefined,
        { lastDue: at(21, 3).toISOString() },
        at(22, 2, 1),
        ON,
      ),
    ).toEqual({
      action: "skip",
      due: at(22, 2).toISOString(),
      reason: "needs-allow",
    });
  });

  it("shared, allowed: run; plan changed or expired: skipped", () => {
    const dir = tmp();
    const a = writeAllow(
      dir,
      "shop",
      staging,
      { kind: "person" },
      at(20, 12),
      ON,
    );
    const r = { lastDue: at(21, 3).toISOString() };
    expect(decide(staging, a, r, at(22, 2, 1), ON).action).toBe("run");
    const changed = listSchedules("shop", [
      mod("web/speed", "staging", { cmd: "./scripts/speed.sh --all" }),
    ])[0];
    expect(decide(changed, a, r, at(22, 2, 1), ON)).toMatchObject({
      action: "skip",
      reason: "plan-changed",
    });
    const short = { ...ON, allowExpiryMs: DAY };
    const b = writeAllow(
      dir,
      "shop",
      staging,
      { kind: "person" },
      at(20, 12),
      short,
    );
    expect(decide(staging, b, r, at(22, 2, 1), short)).toMatchObject({
      action: "skip",
      reason: "expired",
    });
  });
});

describe("the run state", () => {
  it("keeps the last due time, the last result and up to 10 skips", () => {
    const dir = tmp();
    noteScheduleRun(dir, "shop", "a", { lastDue: at(21, 3).toISOString() });
    for (let i = 0; i < 12; i++)
      noteScheduleRun(dir, "shop", "a", {
        lastDue: at(22, 2).toISOString(),
        skip: { due: at(22, i).toISOString(), reason: "needs-allow" },
      });
    noteScheduleRun(dir, "shop", "a", {
      lastDue: at(23, 2).toISOString(),
      last: { runId: "r1", verdict: "passed", at: at(23, 2, 6).toISOString() },
    });
    const r = readScheduleRuns(dir, "shop").a;
    expect(r.lastDue).toBe(at(23, 2).toISOString());
    expect(r.last).toEqual({
      runId: "r1",
      verdict: "passed",
      at: at(23, 2, 6).toISOString(),
    });
    expect(r.skipped).toHaveLength(10);
    expect(r.skipped!.map((x) => x.due)[0]).toBe(at(22, 2).toISOString());
  });
});
