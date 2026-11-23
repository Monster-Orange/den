/**
 * Issue 639: on Linux, `ps -o lstart=` is worked out from the boot time,
 * which is the wall clock minus uptime. Where the monotonic clock drifts
 * and time sync steps the wall clock (a WSL 2 VM), the same live process
 * shows a moving lstart, and `down` took it for a reused pid and never
 * signalled it.
 *
 * On Linux a record now also keeps the leader's start in clock ticks since
 * boot (/proc/<pid>/stat field 22) and the boot id; those don't move with
 * the wall clock. A record without them (older ones, macOS) is checked by
 * lstart, as before.
 */
import { describe, expect, it } from "@jest/globals";
import { spawn } from "child_process";
import {
  classifyGroup,
  parseProcStatTicks,
  recordProcessGroup,
  type LinuxStart,
} from "../../../src/shared/process/process-group.js";

const row = (pid: number, lstart: string, pgid = pid) => ({
  pid,
  pgid,
  zombie: false,
  lstart,
});

const START: LinuxStart = { ticks: "123456", bootId: "boot-a" };
const reader =
  (now: LinuxStart | null) =>
  (pid: number): LinuxStart | null =>
    pid === 4242 ? now : null;

describe("issue 639: the same live process, with the boot time moving", () => {
  it("lstart moved by seconds, ticks and boot id the same: still ours (down stops it)", () => {
    const st = classifyGroup(
      {
        pgid: 4242,
        startedAt: "Sun Nov 22 10:00:00 2026",
        linuxStart: START,
      },
      [row(4242, "Sun Nov 22 10:00:07 2026"), row(4243, "x", 4242)],
      reader(START),
    );
    expect(st).toEqual({ state: "ours", members: [4242, 4243] });
  });
});

describe("issue 639: a pid really reused is never ours", () => {
  it("other ticks: reused, even with the same lstart", () => {
    const st = classifyGroup(
      {
        pgid: 4242,
        startedAt: "Sun Nov 22 10:00:00 2026",
        linuxStart: START,
      },
      [row(4242, "Sun Nov 22 10:00:00 2026")],
      reader({ ticks: "999999", bootId: "boot-a" }),
    );
    expect(st.state).toBe("reused");
  });

  it("a leader that left its group: reused", () => {
    const st = classifyGroup(
      { pgid: 4242, startedAt: "s", linuxStart: START },
      [row(4242, "s", 1)],
      reader(START),
    );
    expect(st.state).toBe("reused");
  });
});

describe("issue 639: after a reboot an old record never matches", () => {
  it("another boot id: reused, even with the same ticks", () => {
    const st = classifyGroup(
      { pgid: 4242, startedAt: "s", linuxStart: START },
      [row(4242, "s")],
      reader({ ticks: START.ticks, bootId: "boot-b" }),
    );
    expect(st.state).toBe("reused");
  });
});

describe("issue 639: older records and other systems keep the lstart check", () => {
  it("a record with no ticks: lstart decides", () => {
    expect(
      classifyGroup(
        { pgid: 4242, startedAt: "a" },
        [row(4242, "b")],
        reader(START),
      ).state,
    ).toBe("reused");
    expect(
      classifyGroup(
        { pgid: 4242, startedAt: "a" },
        [row(4242, "a")],
        reader(START),
      ).state,
    ).toBe("ours");
  });

  it("ticks recorded but /proc can't be read now (not Linux): lstart decides", () => {
    expect(
      classifyGroup(
        { pgid: 4242, startedAt: "a", linuxStart: START },
        [row(4242, "b")],
        reader(null),
      ).state,
    ).toBe("reused");
  });
});

describe("issue 639: reading the start in ticks", () => {
  it("field 22 of /proc/<pid>/stat, past a command name with spaces and parens", () => {
    const fields = Array.from({ length: 30 }, (_, i) => String(i + 3));
    fields[22 - 3] = "778899";
    expect(parseProcStatTicks(`4242 (my (odd) cmd) ${fields.join(" ")}`)).toBe(
      "778899",
    );
  });

  it("a line that isn't a stat line: null", () => {
    expect(parseProcStatTicks("")).toBeNull();
    expect(parseProcStatTicks("4242 (x) S 1 2")).toBeNull();
  });

  it("a new record keeps the ticks and boot id when they can be read", () => {
    // A detached child leads its own group, as a detached `up` does.
    const child = spawn("sleep", ["5"], { detached: true, stdio: "ignore" });
    try {
      const rec = recordProcessGroup(child.pid!, () => START);
      expect(rec?.pgid).toBe(child.pid);
      expect(rec?.linuxStart).toEqual(START);
      // No ticks to read (not Linux): the record is as before.
      expect(recordProcessGroup(child.pid!, () => null)?.linuxStart).toBe(
        undefined,
      );
    } finally {
      process.kill(-child.pid!, "SIGKILL");
    }
  });
});
