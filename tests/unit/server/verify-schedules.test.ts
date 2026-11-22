/**
 * Issue 214 on the server: the schedule loop and its routes.
 *
 *   T18  a staging schedule runs only with a standing Allow; a plan change
 *        lapses it; a local or code-only schedule runs without one.
 *   T19  (the loop's part) a scheduled production run sends only GET, HEAD
 *        and OPTIONS plus write_allow pairs.
 *   T20  the bell shows each scheduled run's result and warns once, 3 days
 *        before an Allow expires; the 3 days come from a setting.
 *
 * Fake repos, a fake command runner and probe, fake time; the routes over a
 * real HTTP server with a signed-in person's guard (or an agent's).
 * Invented names only.
 */
import { afterAll, beforeEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as http from "http";
import type { AddressInfo } from "net";
import * as os from "os";
import * as path from "path";
import { approveKeyHash } from "../../../src/shared/web-session.js";
import {
  handleScheduleRoutes,
  tickSchedules,
  type BellNote,
  type ScheduleServerDeps,
} from "../../../src/ui/server/verify-schedule-routes.js";
import { readRunRecord } from "../../../src/shared/verify/records.js";

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
});

let clock = new Date(2026, 10, 21, 12, 0);
let verifyBlock: Record<string, unknown> = {};
let speedCmd = "make speed";
let cmds: string[] = [];
let probes: string[] = [];
let bell: BellNote[] = [];
let stateDir = "";

function deps(): ScheduleServerDeps {
  return {
    stateDir: () => stateDir,
    projectExists: (p) => p === "north",
    focusedProject: () => "north",
    projects: () => ["north"],
    environments: () => ["local", "staging", "production"],
    verifyConfig: () => verifyBlock,
    repos: () => [
      {
        repo: "shop",
        repoPath: "/repos/shop",
        manifest: {
          name: "shop",
          services: {
            web: {
              health: { production: { url: "https://shop.example/health" } },
            },
          },
          verify: {
            modules: {
              "web/speed": {
                kind: "performance",
                cmd: speedCmd,
                environments: ["staging"],
                schedule: {
                  cron: "0 2 * * *",
                  window: "01:00-05:00",
                  name: "Nightly speed",
                },
              },
              "code/deps": {
                kind: "security",
                cmd: "make audit",
                schedule: { cron: "0 3 * * *", name: "Code scans" },
              },
              "web/smoke": {
                kind: "smoke",
                environments: ["production"],
                schedule: { cron: "0 * * * *", name: "Production smoke" },
              },
            },
          },
        },
      },
    ],
    git: { head: () => "c0ffee1", changedSince: () => [] },
    runCmd: async (m) => {
      cmds.push(m.name);
      return {
        exitCode: m.name === "web/speed" && speedCmd.includes("fail") ? 1 : 0,
      };
    },
    probe: async (url, method = "GET") => {
      probes.push(`${method} ${url}`);
      return 200;
    },
    bell: (n) => bell.push(n),
    now: () => clock,
  };
}

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "den-vsched-"));
  roots.push(stateDir);
  clock = new Date(2026, 10, 21, 12, 0);
  verifyBlock = {};
  speedCmd = "make speed";
  cmds = [];
  probes = [];
  bell = [];
});

const at = (d: number, h: number, mi = 0) => new Date(2026, 10, d, h, mi);
const tick = async (t: Date) => {
  clock = t;
  return tickSchedules(deps());
};

// A server with a person's guard (or an agent's), for the routes.
const AK = "k".repeat(43);
const PERSON = {
  ok: true as const,
  principal: { kind: "person-browser" as const, session: "s1" },
  session: { key: "s1", csrf: "c", approveKeyHash: approveKeyHash(AK) },
};
let asAgent = false;
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  const guard = asAgent
    ? ({ ok: true, principal: { kind: "agent", actor: "agent:bot" } } as never)
    : (PERSON as never);
  if (!(await handleScheduleRoutes(req, res, url.pathname, guard, deps))) {
    res.statusCode = 404;
    res.end();
  }
});
let base = "";
beforeEach(async () => {
  if (!server.listening)
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  asAgent = false;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const get = async () =>
  (
    await fetch(`${base}/api/verify/schedules?project=north`)
  ).json() as Promise<any>;
const post = async (p: string, body: object) => {
  const r = await fetch(`${base}${p}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-den-approve-key": AK },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: (await r.json()) as any };
};
const idOf = async (name: string) =>
  ((await get()).schedules as any[]).find((s) => s.name === name).id as string;

describe("T18: the standing Allow", () => {
  it("staging runs only with an Allow; a plan change lapses it; code-only runs without one", async () => {
    await tick(at(21, 12)); // first sight: baselines
    // 02:01: speed (staging) is skipped, no Allow; 03:01: the code scan runs.
    let notes = await tick(at(22, 2, 1));
    expect(
      notes.find((n) => n.schedule.startsWith("nightly-speed")),
    ).toMatchObject({
      action: "skip",
      reason: "needs-allow",
    });
    expect(cmds).toEqual([]);
    notes = await tick(at(22, 3, 1));
    expect(
      notes.find((n) => n.schedule.startsWith("code-scans")),
    ).toMatchObject({ action: "run" });
    expect(cmds).toEqual(["code/deps"]);

    // The person allows it (signed-in browser): the next night it runs.
    clock = at(22, 12);
    const id = await idOf("Nightly speed");
    const allowed = await post("/api/verify/schedules/allow", {
      project: "north",
      id,
    });
    expect(allowed.status).toBe(200);
    expect(allowed.body.schedule).toMatchObject({
      state: "allowed",
      runs: true,
    });
    cmds = [];
    await tick(at(23, 2, 1));
    expect(cmds).toEqual(["web/speed"]);
    const row = ((await get()).schedules as any[]).find((s) => s.id === id);
    expect(row.last).toMatchObject({ verdict: "passed" });
    const rec = readRunRecord(stateDir, "north", row.last.runId)!;
    expect(rec).toMatchObject({
      trigger: "schedule",
      schedule: id,
      startedBy: { kind: "den", name: "schedule" },
      allowedBy: { kind: "person" },
      env: "staging",
    });

    // The plan changes (its command): the Allow lapses, and it is skipped.
    speedCmd = "make speed --all";
    cmds = [];
    notes = await tick(at(24, 2, 1));
    expect(notes.find((n) => n.schedule === id)).toMatchObject({
      action: "skip",
      reason: "plan-changed",
    });
    expect(cmds).not.toContain("web/speed");
    const changed = ((await get()).schedules as any[]).find((s) => s.id === id);
    expect(changed.state).toBe("plan-changed");
    expect(changed.change).toMatchObject({
      changed: ["shop:web/speed"],
      added: [],
      removed: [],
    });
    expect(changed.skipped.at(-1)).toMatchObject({ reason: "plan-changed" });
  });

  it("an agent can read the list but never allow or run", async () => {
    const id = await idOf("Nightly speed");
    asAgent = true;
    expect((await get()).ok).toBe(true);
    expect(
      (await post("/api/verify/schedules/allow", { project: "north", id }))
        .status,
    ).toBe(403);
    expect(
      (await post("/api/verify/schedules/run", { project: "north", id }))
        .status,
    ).toBe(403);
  });

  it("Run now needs the schedule's Allow; a code-only one needs none", async () => {
    const speed = await idOf("Nightly speed");
    expect(
      (await post("/api/verify/schedules/run", { project: "north", id: speed }))
        .body.code,
    ).toBe("needs_allow");
    const code = await idOf("Code scans");
    const r = await post("/api/verify/schedules/run", {
      project: "north",
      id: code,
    });
    expect(r.status).toBe(202);
    expect(r.body.runId).toMatch(/^\d{14}-/);
  });
});

describe("T19: a scheduled production run is read-only", () => {
  it("only GET goes out, through the guard, and the run's log keeps it", async () => {
    await tick(at(21, 12));
    // Production is shared: it runs under its Allow too.
    await post("/api/verify/schedules/allow", {
      project: "north",
      id: await idOf("Production smoke"),
    });
    const notes = await tick(at(21, 13, 0));
    expect(
      notes.find((n) => n.schedule.startsWith("production-smoke")),
    ).toMatchObject({ action: "run" });
    expect(probes).toEqual(["GET https://shop.example/health"]);
    const row = ((await get()).schedules as any[]).find(
      (s) => s.name === "Production smoke",
    );
    expect(row.readOnly).toBe(true);
    const rec = readRunRecord(stateDir, "north", row.last.runId)!;
    expect(rec.modules[0].requests).toEqual([
      { method: "GET", url: "https://shop.example/health", status: 200 },
    ]);
  });
});

describe("T20: the bell", () => {
  it("each scheduled run's result; a failure says how many failed", async () => {
    await tick(at(21, 12));
    await tick(at(22, 3, 1));
    expect(bell.find((b) => b.msg.key === "bell.m.vschedPass")).toMatchObject({
      kind: "service",
      scope: "workspace/north",
      msg: { vars: { env: "local", n: 1 } },
    });
    // A failing nightly run on staging, under its Allow.
    clock = at(22, 12);
    await post("/api/verify/schedules/allow", {
      project: "north",
      id: await idOf("Nightly speed"),
    });
    speedCmd = "make speed fail";
    // Its Allow was for "make speed": allow the failing plan too.
    await post("/api/verify/schedules/allow", {
      project: "north",
      id: await idOf("Nightly speed"),
    });
    await tick(at(23, 2, 1));
    expect(bell.find((b) => b.msg.key === "bell.m.vschedFail")).toMatchObject({
      msg: { vars: { env: "staging", n: 1, total: 1 } },
    });
  });

  it("warns once, 3 days before an Allow expires; the 3 days come from a setting", async () => {
    verifyBlock = { schedule: { allow_expiry: 10, expiry_warning: 4 } };
    clock = at(1, 12);
    await post("/api/verify/schedules/allow", {
      project: "north",
      id: await idOf("Nightly speed"),
    });
    // Expires Nov 11, 12:00. 4 days before: Nov 7, 12:00.
    await tick(at(7, 11, 0));
    expect(
      bell.filter((b) => b.msg.key === "bell.m.vschedExpire"),
    ).toHaveLength(0);
    await tick(at(7, 12, 1));
    await tick(at(8, 9, 0));
    const warned = bell.filter((b) => b.msg.key === "bell.m.vschedExpire");
    expect(warned).toHaveLength(1);
    expect(warned[0]).toMatchObject({
      kind: "decision",
      msg: { vars: { name: "Nightly speed", n: 4 } },
    });
    expect(warned[0].link).toMatch(/^\/verify\?schedules=1#sch-nightly-speed-/);
  });
});
