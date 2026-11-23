/**
 * Issue 1225: after a restart, the services that were up come back, and
 * stay back. Root cause on one install: two services recorded as process
 * groups only (no containers on the record) were brought up seconds after
 * the machine started, before the container runtime was ready; their own
 * dev commands need it, so they exited at once, and nothing tried again or
 * said so (every restore line was logged at a level that isn't kept).
 *
 *  - The restore waits for the container runtime whenever this machine has
 *    one, not only when a record lists containers.
 *  - After each project's Up, its services are checked once they settle; one
 *    that died is tried again, and after the last try it is named as failed,
 *    with its reason.
 *  - Results are per service; a failure is logged at warn (kept across a
 *    restart); the bell gets one line: "Brought back N services after the
 *    restart", naming each failure.
 *
 * Invented names only.
 */
import { describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  containerListingOnceReady,
  containerRuntimeOnPath,
  readLastRestore,
  restoreDoctorLine,
  restoreServicesOnBoot,
  restoreSummary,
  shouldWaitForContainers,
  stillDownOf,
  waitForContainers,
  writeLastRestore,
} from "../../../src/shared/environment-manager/restore-on-boot.js";
import type { DaemonRecord } from "../../../src/shared/environment-manager/service-runner.js";

const groupOnly = {
  address: "kiosk/web",
  repoName: "kiosk",
  subsystem: "web",
  repoPath: "/w/kiosk",
  logPath: "/w/kiosk/log",
  startedAt: new Date("2026-11-13T08:00:00Z"),
  workspaces: ["harbor"],
  pgid: 999_991,
  pgidStartedAt: "Thu Nov 13 08:00:00 2026",
  containers: [],
} as DaemonRecord;

describe("issue 1225: the restore waits for the container runtime", () => {
  it("a record with no containers still waits, when this machine has a container runtime", () => {
    expect(shouldWaitForContainers([groupOnly], { runtime: true })).toBe(true);
  });

  it("no runtime on the machine and no containers on the record: no wait", () => {
    expect(shouldWaitForContainers([groupOnly], { runtime: false })).toBe(
      false,
    );
  });

  it("a record that lists containers waits, as before", () => {
    expect(
      shouldWaitForContainers([{ ...groupOnly, containers: ["kiosk-db"] }], {
        runtime: false,
      }),
    ).toBe(true);
  });
});

describe("issue 1225: the wait waits until the runtime answers", () => {
  it("a runtime that doesn't answer yet is not ready, even with no containers running: the wait goes on", async () => {
    let calls = 0;
    const list = containerListingOnceReady({
      // The runtime answers on the third look.
      dockerNames: async () => (++calls >= 3 ? [] : null),
      bases: async () => new Set<string>(),
    });
    const r = await waitForContainers(60, list, async () => undefined, 1);
    expect(calls).toBe(3);
    expect(r).toEqual(new Set());
  });

  it("the runtime is detected on PATH, never assumed", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-1225-path-"));
    try {
      expect(await containerRuntimeOnPath(dir)).toBe(false);
      fs.writeFileSync(path.join(dir, "docker"), "#!/bin/sh\n", {
        mode: 0o755,
      });
      expect(await containerRuntimeOnPath(dir)).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

/** A restore of `plan` whose Up always exits 0; `downAfter` says what died. */
function run(
  plan: Map<string, string[]>,
  downAfter: (try_: number, addrs: string[]) => string[],
) {
  const lines: { line: string; level?: string }[] = [];
  const execs: string[] = [];
  let tries = 0;
  const done = restoreServicesOnBoot(plan, {
    enabled: true,
    isActive: () => true,
    forget: () => undefined,
    exec: async (ws, addrs) => {
      execs.push(`${ws}:${addrs.join(",")}`);
      return 0;
    },
    stillDown: async (_ws, addrs) => downAfter(++tries, addrs),
    tries: 3,
    sleep: async () => undefined,
    settleMs: 1,
    log: (line, level) => lines.push({ line, level }),
  });
  return { done, lines, execs };
}

describe("issue 1225: a service that dies after its Up", () => {
  it("is tried again, and counts as brought back once it stays up", async () => {
    const { done, execs } = run(new Map([["harbor", ["kiosk/web"]]]), (t) =>
      t === 1 ? ["kiosk/web"] : [],
    );
    const r = await done;
    expect(execs).toEqual(["harbor:kiosk/web", "harbor:kiosk/web"]);
    expect(r.brought).toEqual(["kiosk/web"]);
    expect(r.failedServices).toEqual([]);
  });

  it("after the last try it is named as failed, with its reason, at warn; the others still come back", async () => {
    const { done, lines, execs } = run(
      new Map([
        ["harbor", ["kiosk/web"]],
        ["meadow", ["ledger/api"]],
      ]),
      (_t, addrs) => addrs.filter((a) => a === "kiosk/web"),
    );
    const r = await done;
    expect(execs.filter((e) => e.startsWith("harbor"))).toHaveLength(3);
    expect(r.brought).toEqual(["ledger/api"]);
    expect(r.failedServices).toEqual([
      { address: "kiosk/web", why: "stopped again after it started (3 tries)" },
    ]);
    const warn = lines.filter((l) => l.level === "warn").map((l) => l.line);
    expect(warn.join("\n")).toContain("kiosk/web");
  });
});

describe("issue 1225: the bell's line", () => {
  it("says how many came back, and names each failure with its reason", () => {
    expect(
      restoreSummary({
        brought: ["kiosk/web", "ledger/api"],
        failedServices: [],
      }),
    ).toEqual({ count: 2, text: "Brought back 2 services after the restart." });
    expect(
      restoreSummary({
        brought: ["ledger/api"],
        failedServices: [{ address: "kiosk/web", why: "exit 1" }],
      })?.text,
    ).toBe(
      "Brought back 1 service after the restart. Not brought back: kiosk/web (exit 1).",
    );
  });

  it("nothing to bring back: no line", () => {
    expect(restoreSummary({ brought: [], failedServices: [] })).toBeNull();
  });
});

describe("issue 1225: which services are down again after they settle", () => {
  it("one whose record is gone (the startup reaper dropped it) or whose group is gone is down; a live one is up", async () => {
    const live = { ...groupOnly, address: "kiosk/web", pgid: 41 };
    const dead = { ...groupOnly, address: "ledger/api", pgid: 42 };
    const down = await stillDownOf(["kiosk/web", "ledger/api", "atlas/ui"], {
      records: [live, dead] as DaemonRecord[],
      running: new Set<string>(),
      groupState: async (g) =>
        g.pgid === 41 ? { state: "ours", members: [41] } : { state: "gone" },
    });
    expect(down).toEqual(["ledger/api", "atlas/ui"]);
  });
});

describe("issue 1225: doctor says what the last restore did", () => {
  it("keeps the last restore's result, and says it", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-1225-last-"));
    try {
      writeLastRestore(
        dir,
        {
          brought: ["ledger/api"],
          failedServices: [{ address: "kiosk/web", why: "exit 1" }],
        },
        new Date("2026-11-22T23:00:00Z"),
      );
      const last = readLastRestore(dir);
      expect(last?.at).toBe("2026-11-22T23:00:00.000Z");
      expect(restoreDoctorLine({ enabled: true, last })).toBe(
        "Services after the last restart (2026-11-22T23:00:00.000Z): Brought back 1 service after the restart. Not brought back: kiosk/web (exit 1).",
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("with the setting off, doctor says so", () => {
    expect(restoreDoctorLine({ enabled: false, last: null })).toBe(
      "services.restore_on_boot is off: services that were up stay down after a restart.",
    );
  });

  it("on, and nothing restored yet: no line", () => {
    expect(restoreDoctorLine({ enabled: true, last: null })).toBeNull();
  });
});
