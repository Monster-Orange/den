/**
 * 0.4.46 services.restore_on_boot (on by default): after the machine
 * restarts, every project's services that were up come back up, from the
 * record Den keeps of what runs (daemons.json). A person's `down` takes a
 * service off that record, so what someone stopped stays stopped. A record
 * whose checkout is gone, or one Den can't tell is down, is left alone.
 *
 * A temp daemons file; the bring-up is the test's. Invented names only.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  restoreServicesOnBoot,
  servicesRestoreOnBoot,
  servicesRestoreWaitSeconds,
  servicesToRestore,
  waitForContainers,
} from "../../../src/shared/environment-manager/restore-on-boot.js";
import {
  listDaemons,
  registerDaemon,
  unregisterDaemon,
  type DaemonRecord,
} from "../../../src/shared/environment-manager/service-runner.js";

const dirs: string[] = [];
afterEach(() => {
  delete process.env.DEN_DAEMONS_FILE;
  for (const d of dirs.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "den-restore-"));
  dirs.push(d);
  return d;
}

/** A service `up` started as a process group, in `workspaces`. */
function rec(
  address: string,
  workspaces: string[],
  pgid = 999_991,
): DaemonRecord {
  const dir = tmp();
  return {
    address,
    repoName: address.split("/")[0]!,
    subsystem: address.split("/")[1] ?? "app",
    repoPath: dir,
    logPath: path.join(dir, "log"),
    startedAt: new Date("2026-11-13T08:00:00Z"),
    workspaces,
    pgid,
    pgidStartedAt: "Thu Nov 13 08:00:00 2026",
  };
}

describe("0.4.46: services.restore_on_boot", () => {
  it("brings back each project's services that were up and aren't now; a person's down stays down", async () => {
    process.env.DEN_DAEMONS_FILE = path.join(tmp(), "daemons.json");
    registerDaemon(rec("shop-api/api", ["north"]));
    registerDaemon(rec("shop-web/web", ["north"]));
    registerDaemon(rec("ledger/worker", ["back-office"]));
    registerDaemon(rec("notes/app", ["north"]));
    // A person stopped notes/app (what `down` does to the record).
    unregisterDaemon("notes/app");
    const before = listDaemons();
    const plan = await servicesToRestore(before, { running: new Set() });
    expect(Object.fromEntries(plan)).toEqual({
      north: ["shop-api/api", "shop-web/web"],
      "back-office": ["ledger/worker"],
    });
  });

  it("leaves alone what still runs, what Den can't tell, and a record whose checkout is gone", async () => {
    const live = { ...rec("a/live", ["north"], process.pid) };
    const plan = await servicesToRestore(
      [
        live,
        {
          ...rec("b/unknown", ["north"]),
          pgid: undefined,
          pgidStartedAt: undefined,
        },
        rec("c/moved", ["north"]),
        {
          ...rec("d/dead", ["north"]),
          pgid: undefined,
          containers: ["d-dead-1"],
        },
        { ...rec("f/up", ["north"]), pgid: undefined, containers: ["f-up-1"] },
        { ...rec("e/legacy", []) },
      ],
      {
        pruned: new Map([["c/moved", "stale" as const]]),
        running: new Set(["f-up-1"]),
        groupState: async (g) =>
          g.pgid === process.pid
            ? { state: "ours", members: [g.pgid] }
            : { state: "gone" },
      },
    );
    expect(Object.fromEntries(plan)).toEqual({ north: ["d/dead"] });
  });

  it("brings each project up through Den's own Up, says what failed, and does nothing when off", async () => {
    const plan = new Map([
      ["north", ["shop-api/api"]],
      ["back-office", ["ledger/worker"]],
      ["gone", ["x/y"]],
    ]);
    const calls: string[] = [];
    const lines: string[] = [];
    const r = await restoreServicesOnBoot(plan, {
      enabled: true,
      isActive: (ws) => ws !== "gone",
      forget: (a) => calls.push(`forget ${a}`),
      exec: async (ws, addrs) => {
        calls.push(`${ws}:${addrs.join(",")}`);
        return ws === "back-office" ? 1 : 0;
      },
      log: (l) => lines.push(l),
    });
    expect(calls).toEqual([
      "forget shop-api/api",
      "north:shop-api/api",
      "forget ledger/worker",
      "back-office:ledger/worker",
    ]);
    expect(r.restored).toEqual(["north"]);
    expect(r.failed).toEqual([{ workspace: "back-office", why: "exit 1" }]);
    expect(r.skipped).toEqual(["gone"]);
    expect(lines.join("\n")).toContain("north");
    const off = await restoreServicesOnBoot(plan, {
      enabled: false,
      isActive: () => true,
      forget: () => {
        throw new Error("must not forget");
      },
      exec: async () => {
        throw new Error("must not run");
      },
      log: () => undefined,
    });
    expect(off.restored).toEqual([]);
  });

  it("without Docker, nothing container-based is judged down; the wait for it is a setting", async () => {
    const plan = await servicesToRestore(
      [
        {
          ...rec("d/dead", ["north"]),
          pgid: undefined,
          containers: ["d-dead-1"],
        },
      ],
      { running: null },
    );
    expect(plan.size).toBe(0);
    let n = 0;
    const got = await waitForContainers(
      60,
      async () => (++n < 3 ? null : new Set(["x"])),
      async () => undefined,
    );
    expect([n, [...got!]]).toEqual([3, ["x"]]);
    expect(servicesRestoreWaitSeconds(() => ({}))).toBe(300);
    expect(() =>
      servicesRestoreWaitSeconds(() => ({
        services: { restore_wait_seconds: -1 },
      })),
    ).toThrow("services.restore_wait_seconds must be a number, at least 0");
  });

  it("services.restore_on_boot is a setting, on by default", () => {
    expect(servicesRestoreOnBoot(() => ({}))).toBe(true);
    expect(
      servicesRestoreOnBoot(() => ({ services: { restore_on_boot: false } })),
    ).toBe(false);
    expect(() =>
      servicesRestoreOnBoot(
        () => ({ services: { restore_on_boot: "no" } }) as never,
      ),
    ).toThrow("services.restore_on_boot must be true or false");
  });
});
