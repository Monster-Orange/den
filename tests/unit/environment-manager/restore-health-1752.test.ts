import { describe, expect, it } from "@jest/globals";
import {
  restoreServicesOnBoot,
  restoreSummary,
  type HealthVerdict,
} from "../../../src/shared/environment-manager/restore-on-boot.js";

function run(
  plan: Map<string, string[]>,
  health?: (address: string, check: number) => HealthVerdict,
) {
  const execs: string[] = [];
  const sleeps: number[] = [];
  const lines: { line: string; level?: string }[] = [];
  const checks = new Map<string, number>();
  const done = restoreServicesOnBoot(plan, {
    enabled: true,
    isActive: () => true,
    forget: () => undefined,
    exec: async (ws, addrs) => {
      execs.push(`${ws}:${addrs.join(",")}`);
      return 0;
    },
    stillDown: async (_ws, addrs) => [...addrs],
    ...(health
      ? {
          health: async (_ws: string, a: string) => {
            const n = (checks.get(a) ?? 0) + 1;
            checks.set(a, n);
            return health(a, n);
          },
        }
      : {}),
    tries: 3,
    settleMs: 30_000,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    log: (line, level) => lines.push({ line, level }),
  });
  return { done, execs, sleeps, lines };
}

describe("issue 1752: a service whose health check passes is brought back", () => {
  it("a detached `up` exits 0, its record shows no process, its check passes: brought back on the first try, no retry, no bell line naming it", async () => {
    const { done, execs, sleeps } = run(
      new Map([["harbor", ["kiosk/web"]]]),
      () => "ok",
    );
    const r = await done;
    expect(execs).toEqual(["harbor:kiosk/web"]);
    expect(sleeps).toEqual([30_000]);
    expect(r.brought).toEqual(["kiosk/web"]);
    expect(r.restored).toEqual(["harbor"]);
    expect(r.failedServices).toEqual([]);
    expect(restoreSummary(r)?.text).toBe(
      "Brought back 1 service after the restart.",
    );
  });

  it("Den's own Up runs first, even when the check already passes: a check on shared infra can pass while the service is down", async () => {
    const { done, execs } = run(
      new Map([["harbor", ["kiosk/web"]]]),
      () => "ok",
    );
    await done;
    expect(execs).toEqual(["harbor:kiosk/web"]);
  });

  it("each service on its own check: the one that passes is back, only the failing one is tried again", async () => {
    const { done, execs } = run(
      new Map([["harbor", ["kiosk/web", "kiosk/worker"]]]),
      (a, n) => (a === "kiosk/web" || n > 1 ? "ok" : "error"),
    );
    const r = await done;
    expect(execs).toEqual([
      "harbor:kiosk/web,kiosk/worker",
      "harbor:kiosk/worker",
    ]);
    expect(r.brought).toEqual(["kiosk/web", "kiosk/worker"]);
    expect(r.failedServices).toEqual([]);
  });

  it("the check adds no wait: one settle per try, as with no check", async () => {
    const withCheck = run(new Map([["harbor", ["kiosk/web"]]]), () => "error");
    const without = run(new Map([["harbor", ["kiosk/web"]]]));
    await withCheck.done;
    await without.done;
    expect(withCheck.sleeps).toEqual(without.sleeps);
    expect(withCheck.sleeps).toEqual([30_000, 30_000, 30_000]);
  });

  it("a check that throws counts as no verdict: the record decides", async () => {
    const execs: string[] = [];
    const r = await restoreServicesOnBoot(
      new Map([["harbor", ["kiosk/web"]]]),
      {
        enabled: true,
        isActive: () => true,
        forget: () => undefined,
        exec: async (ws, addrs) => {
          execs.push(`${ws}:${addrs.join(",")}`);
          return 0;
        },
        stillDown: async () => [],
        health: async () => {
          throw new Error("boom");
        },
        sleep: async () => undefined,
        log: () => undefined,
      },
    );
    expect(r.brought).toEqual(["kiosk/web"]);
    expect(execs).toHaveLength(1);
  });
});

describe("issue 1752: a failing health check is still named", () => {
  it("fails after 3 tries: named with its reason, at warn", async () => {
    const { done, execs, lines } = run(
      new Map([["harbor", ["kiosk/web"]]]),
      () => "error",
    );
    const r = await done;
    expect(execs).toHaveLength(3);
    expect(r.brought).toEqual([]);
    expect(r.failedServices).toEqual([
      {
        address: "kiosk/web",
        why: "its health check failed after it started (3 tries)",
      },
    ]);
    expect(
      lines
        .filter((l) => l.level === "warn")
        .map((l) => l.line)
        .join("\n"),
    ).toContain("kiosk/web");
  });
});

describe("issue 1752: a service with no health check keeps today's behaviour", () => {
  it("no check (null) or no health dep: the record decides, and after 3 tries it is named as before", async () => {
    for (const h of [() => null, undefined] as const) {
      const { done, execs } = run(new Map([["harbor", ["kiosk/web"]]]), h);
      const r = await done;
      expect(execs).toHaveLength(3);
      expect(r.failedServices).toEqual([
        {
          address: "kiosk/web",
          why: "stopped again after it started (3 tries)",
        },
      ]);
    }
  });
});
