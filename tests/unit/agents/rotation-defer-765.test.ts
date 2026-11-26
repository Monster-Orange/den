import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  deferRotation,
  dueFor,
  launchRotation,
  parseDeferTime,
  readRotation,
  rotationInfo,
  writeRotation,
} from "../../../src/shared/agents/rotation.js";
import type { AgentRecord } from "../../../src/shared/agents/records.js";
import {
  deprecatedKeys,
  rotationDeferMaxBad,
} from "../../../src/ui/cli/doctor-command.js";

const dirs: string[] = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "den-765b-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});

const now = new Date("2026-03-04T10:00:00.000Z");
const later = (ms: number) => new Date(now.getTime() + ms);
const H = 3_600_000;

describe("issue 765: put off rotation until a time", () => {
  it("a deferred agent is not due before its time, and is due after it (compactions)", () => {
    const f = tmp();
    writeRotation(f, { conversation: "c1", compactions: 3, after: 3 });
    expect(dueFor(readRotation(f), "c1", now)).toBe("compactions");
    deferRotation(f, later(2 * H));
    expect(dueFor(readRotation(f), "c1", now)).toBeUndefined();
    expect(dueFor(readRotation(f), "c1", later(2 * H - 1))).toBeUndefined();
    expect(dueFor(readRotation(f), "c1", later(2 * H))).toBe("compactions");
  });

  it("a merged pull request waits too", () => {
    const f = tmp();
    writeRotation(f, {
      conversation: "c1",
      compactions: 0,
      after: 3,
      due: "pr-merged",
    });
    deferRotation(f, later(H));
    expect(dueFor(readRotation(f), "c1", now)).toBeUndefined();
    expect(dueFor(readRotation(f), "c1", later(H + 1))).toBe("pr-merged");
  });

  it("off clears it: the normal rule applies at once", () => {
    const f = tmp();
    writeRotation(f, { conversation: "c1", compactions: 4, after: 3 });
    deferRotation(f, later(H));
    deferRotation(f, null);
    expect(readRotation(f)?.deferredUntil).toBeUndefined();
    expect(dueFor(readRotation(f), "c1", now)).toBe("compactions");
  });

  it("the time outlives a new conversation; a past one is dropped", () => {
    const f = tmp();
    writeRotation(f, { conversation: "c1", compactions: 3, after: 3 });
    deferRotation(f, later(H));
    const s = launchRotation(f, "c2", 3, now);
    expect(s.compactions).toBe(0);
    expect(s.deferredUntil).toBe(later(H).toISOString());
    const past = launchRotation(f, "c3", 3, later(2 * H));
    expect(past.deferredUntil).toBeUndefined();
  });

  it("a bad stamp in rotation.json is ignored, not a deferral", () => {
    const f = tmp();
    fs.writeFileSync(
      path.join(f, "rotation.json"),
      JSON.stringify({ compactions: 3, after: 3, deferredUntil: "soon" }),
    );
    expect(readRotation(f)?.deferredUntil).toBeUndefined();
    expect(dueFor(readRotation(f), undefined, now)).toBe("compactions");
  });
});

describe("issue 765: the agent's row (rotationInfo)", () => {
  it("deferred: not due, even with its pull request merged, and the row has the time", () => {
    const state = tmp();
    const files = path.join(state, "agent-files", "be-dev");
    fs.mkdirSync(files, { recursive: true });
    writeRotation(files, { conversation: "c1", compactions: 0, after: 3 });
    const until = new Date(Date.now() + H);
    deferRotation(files, until);
    const rec = {
      id: "be-dev",
      resumeToken: "c1",
      outcome: { prMerged: true },
    } as unknown as AgentRecord;
    const info = rotationInfo(state, rec)!;
    expect(info.due).toBeUndefined();
    expect(info.ready).toBe(false);
    expect(info.deferredUntil).toBe(until.toISOString());
    deferRotation(files, null);
    expect(rotationInfo(state, rec)!.due).toBe("pr-merged");
  });
});

describe("issue 765: the time a person types", () => {
  it.each([
    ["+30m", 30 * 60_000],
    ["+2h", 2 * H],
    ["+1d", 24 * H],
    ["2026-03-04T15:00:00Z", 5 * H],
  ])("%s", (raw, ms) => {
    expect(parseDeferTime(raw, now)?.toISOString()).toBe(
      later(ms).toISOString(),
    );
  });

  it("HH:MM is the next such time on this machine's clock", () => {
    const at = parseDeferTime("23:30", now)!;
    expect(at.getTime()).toBeGreaterThan(now.getTime());
    expect(at.getTime() - now.getTime()).toBeLessThanOrEqual(24 * H);
    expect(at.getHours()).toBe(23);
    expect(at.getMinutes()).toBe(30);
  });

  it("off is null", () => {
    expect(parseDeferTime("off", now)).toBeNull();
  });

  it.each(["+100000000d", "+99999999999999m", "+275761-01-01T00:00:00Z"])(
    "refuses %j: too far off to be a time at all",
    (raw) => {
      expect(() => parseDeferTime(raw, now)).toThrow(/a time to come/);
    },
  );

  it("refuses an ISO year past what a date can hold", () => {
    expect(() => parseDeferTime("275760-09-14T00:00:00Z", now)).toThrow(
      /a time to come/,
    );
  });

  it.each(["", "soon", "+0h", "+5x", "25:00", "2026-03-04T09:00:00Z"])(
    "refuses %j, saying what it takes",
    (raw) => {
      expect(() => parseDeferTime(raw, now)).toThrow(
        /a time to come: \+30m, \+2h, \+1d, HH:MM, an ISO time, or off/,
      );
    },
  );
});

import * as http from "http";
import type { AddressInfo } from "net";
import { cmdAgents } from "../../../src/ui/cli/agents-command.js";
import { handleAgentRoutes } from "../../../src/ui/server/agent-routes.js";
import { ACTOR_TOKEN_ENV } from "../../../src/shared/actor-token.js";
import { cleanupRigs, rig, type Rig } from "./helpers/rig.js";

const servers: http.Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0))
    await new Promise<void>((res) => s.close(() => res()));
  await cleanupRigs();
});
const agents = (r: Rig, ...args: string[]) => cmdAgents(args, r.deps);
const filesOf = (r: Rig, id: string) =>
  path.join(r.stateDir, "agent-files", id);
async function started(r: Rig): Promise<void> {
  r.deps.env = { ...r.deps.env, CLAUDE_CONFIG_DIR: path.join(r.dir, "cc") };
  expect(await agents(r, "start", "-w", "north", "--persona", "be-dev")).toBe(
    0,
  );
}

describe("issue 765: agents rotate <id> --defer (CLI)", () => {
  it("puts it off, shows it, and off undoes it", async () => {
    const r = await rig();
    await started(r);
    expect(await agents(r, "rotate", "be-dev", "--defer", "+2h")).toBe(0);
    const until = readRotation(filesOf(r, "be-dev"))?.deferredUntil;
    expect(until).toBeDefined();
    const ms = Date.parse(until!) - Date.now();
    expect(ms).toBeGreaterThan(2 * H - 60_000);
    expect(ms).toBeLessThanOrEqual(2 * H);
    expect(r.out.join("\n")).toMatch(/be-dev's rotation is put off until/);
    r.out.length = 0;
    expect(await agents(r, "rotate", "be-dev", "--show")).toBe(0);
    expect(r.out.join("\n")).toMatch(/put off until/);
    expect(await agents(r, "rotate", "be-dev", "--defer", "off")).toBe(0);
    expect(readRotation(filesOf(r, "be-dev"))?.deferredUntil).toBeUndefined();
  });

  it("a bad time is a usage error that says what it takes", async () => {
    const r = await rig();
    await started(r);
    expect(await agents(r, "rotate", "be-dev", "--defer", "soon")).toBe(2);
    expect(r.err.join("\n")).toMatch(/\+30m, \+2h, \+1d, HH:MM/);
  });

  it("refused in an agent's session: an agent can't put its own rotation off", async () => {
    const r = await rig();
    await started(r);
    r.deps.env = { ...r.deps.env, [ACTOR_TOKEN_ENV]: "x" };
    expect(await agents(r, "rotate", "be-dev", "--defer", "+2h")).toBe(1);
    expect(r.err.join("\n")).toMatch(/only a person can change rotation/);
    expect(readRotation(filesOf(r, "be-dev"))?.deferredUntil).toBeUndefined();
  });
});

describe("issue 765: POST /api/workspaces/:ws/agents/:id/defer", () => {
  async function server(r: Rig) {
    const srv = http.createServer((req, res) => {
      void handleAgentRoutes(req, res, new URL(req.url!, "http://x").pathname, {
        agents: r.deps,
      }).then((done) => {
        if (!done) res.writeHead(404).end();
      });
    });
    servers.push(srv);
    await new Promise<void>((res) => srv.listen(0, "localhost", () => res()));
    const port = (srv.address() as AddressInfo).port;
    return async (body: unknown) => {
      const res = await fetch(
        `http://localhost:${port}/api/workspaces/north/agents/be-dev/defer`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      return {
        status: res.status,
        json: (await res.json()) as Record<string, unknown>,
      };
    };
  }

  it("sets and clears; a past time, a bad field or a wrong type is a 400", async () => {
    const r = await rig();
    await started(r);
    const call = await server(r);
    const until = new Date(Date.now() + H).toISOString();
    const ok = await call({ until });
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({ ok: true, deferredUntil: until });
    expect(readRotation(filesOf(r, "be-dev"))?.deferredUntil).toBe(until);
    expect(
      (await call({ until: new Date(Date.now() - H).toISOString() })).status,
    ).toBe(400);
    expect((await call({ until: 5 })).status).toBe(400);
    const far = await call({
      until: new Date(Date.now() + 8 * 24 * H).toISOString(),
    });
    expect(far.status).toBe(400);
    expect(JSON.stringify(far.json)).toMatch(
      /agents\.rotation_defer_max_hours/,
    );
    expect((await call({ when: until })).status).toBe(400);
    const off = await call({ until: null });
    expect(off.json).toMatchObject({ ok: true, deferredUntil: null });
    expect(readRotation(filesOf(r, "be-dev"))?.deferredUntil).toBeUndefined();
  });
});

import {
  checkAgentRotationDefer,
  resolveAgentsDeps,
  runAgentRotationDefer,
} from "../../../src/ui/cli/agent-ops.js";
import { HELD_WRITE_RISK } from "../../../src/shared/approval-policy.js";
import { heldActions } from "../../../src/ui/server/held-actions.js";

describe("issue 765: agent_rotation_defer (the held ask)", () => {
  it("fixes the time when asked, says what it does, and on Allow puts it off", async () => {
    const r = await rig();
    await started(r);
    const d = resolveAgentsDeps(r.deps);
    const asked = new Date();
    const c = checkAgentRotationDefer(
      d,
      { agent: "be-dev", until: "+2h" },
      { agent: "be-dev", project: "north" },
      asked,
    );
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    const until = new Date(asked.getTime() + 2 * H).toISOString();
    expect(c.args).toEqual({ agent: "be-dev", project: "north", until });
    expect(c.summary).toMatch(/^Put be-dev's rotation off until /);
    expect(c.details.join("\n")).toMatch(/nothing rotates it/);
    const ran = await runAgentRotationDefer(
      d,
      c.args as unknown as Record<string, unknown>,
      new Date(asked.getTime() + 30 * 60_000),
    );
    expect(ran).toEqual({ ok: true, agent: "be-dev", project: "north", until });
    expect(readRotation(filesOf(r, "be-dev"))?.deferredUntil).toBe(until);
    const off = checkAgentRotationDefer(d, { agent: "be-dev", until: "off" });
    expect(off.ok && off.params).toEqual({ agent: "be-dev", clears: "1" });
    await runAgentRotationDefer(d, off.ok ? (off.args as never) : {});
    expect(readRotation(filesOf(r, "be-dev"))?.deferredUntil).toBeUndefined();
  }, 30_000);

  it("refuses: no time, a past time, off with nothing put off, another project's agent", async () => {
    const r = await rig();
    await started(r);
    const d = resolveAgentsDeps(r.deps);
    const err = (
      raw: Record<string, unknown>,
      who: { agent?: string; project?: string } = {},
    ) => {
      const c = checkAgentRotationDefer(d, raw, who);
      return c.ok ? "" : c.error;
    };
    expect(err({ agent: "be-dev" })).toMatch(/until is required/);
    expect(
      err({ agent: "be-dev", until: new Date(Date.now() - H).toISOString() }),
    ).toMatch(/a time to come/);
    expect(err({ agent: "be-dev", until: "off" })).toMatch(/nothing to undo/);
    expect(
      err({ agent: "be-dev", until: "+1h" }, { agent: "x", project: "south" }),
    ).toMatch(/can ask for that project's agents only/);
    expect(readRotation(filesOf(r, "be-dev"))?.deferredUntil).toBeUndefined();
  }, 30_000);

  it("it widens: held for the person's Allow, and the server knows it", () => {
    expect(HELD_WRITE_RISK.agent_rotation_defer?.risk).toBe("widens");
    expect(Object.keys(heldActions({} as never))).toContain(
      "agent_rotation_defer",
    );
    expect(
      heldActions({} as never).agent_rotation_defer.check({
        agent: "a",
        until: "+1h",
      }),
    ).toEqual({
      ok: false,
      error: "this Den can't put an agent's rotation off here",
    });
  });
});

import {
  agentsRotationDeferMaxHours,
  AGENTS_RESERVED_KEYS,
} from "../../../src/shared/den-config.js";
import * as cliRows from "../../../src/shared/settings-cli-rows.js";
import { DOTTED } from "../../../src/ui/cli/config-command.js";
import { DEN_SETTINGS } from "../../../src/ui/server/public/settings-registry.js";

describe("issue 765: the most a rotation can be put off (a setting)", () => {
  const cap = 7 * 24 * H;
  it("parseDeferTime: at the cap is fine, a minute past is refused, naming the setting", () => {
    expect(parseDeferTime("+7d", now, cap)?.getTime()).toBe(
      now.getTime() + cap,
    );
    expect(() => parseDeferTime("+10081m", now, cap)).toThrow(
      /agents\.rotation_defer_max_hours \(168 h\)/,
    );
  });

  it("agents.rotation_defer_max_hours: 168 when unset; 1 to 8760; a wrong value refused naming it", () => {
    const cfg = (agents: Record<string, unknown> | undefined) => () =>
      ({ agents }) as never;
    expect(agentsRotationDeferMaxHours(cfg(undefined))).toBe(168);
    expect(
      agentsRotationDeferMaxHours(cfg({ rotation_defer_max_hours: 24 })),
    ).toBe(24);
    for (const bad of [0, 8761, "24"])
      expect(() =>
        agentsRotationDeferMaxHours(cfg({ rotation_defer_max_hours: bad })),
      ).toThrow(/agents\.rotation_defer_max_hours/);
    expect(AGENTS_RESERVED_KEYS).toContain("rotation_defer_max_hours");
  });

  it("the CLI and the held ask refuse past it", async () => {
    const r = await rig();
    await started(r);
    expect(await agents(r, "rotate", "be-dev", "--defer", "+8d")).toBe(2);
    expect(r.err.join("\n")).toMatch(/agents\.rotation_defer_max_hours/);
    const c = checkAgentRotationDefer(resolveAgentsDeps(r.deps), {
      agent: "be-dev",
      until: "+8d",
    });
    expect(c.ok ? "" : c.error).toMatch(/agents\.rotation_defer_max_hours/);
    expect(readRotation(filesOf(r, "be-dev"))?.deferredUntil).toBeUndefined();
  }, 30_000);

  it("is in Settings (Agents) and config, a person's only, written to user.yml", () => {
    const row = (
      DEN_SETTINGS as { keys?: string[]; category?: string; control?: object }[]
    ).find((s) => s.keys?.includes("agents_rotation.defer_max_hours"));
    expect(row).toMatchObject({
      category: "agents",
      control: { type: "number", min: 1, max: 8760, unit: "h" },
    });
    expect(DOTTED["agents.rotation_defer_max_hours"]).toEqual([
      "agents_rotation",
      "defer_max_hours",
    ]);
    expect(cliRows.PERSON_ONLY_SETTINGS).toContain("agents_rotation");
    const user: Record<string, unknown> = { agents: { resume: { batch: 2 } } };
    expect(
      cliRows.patchCliRows(user, {
        agents_rotation: { defer_max_hours: 24 },
      }),
    ).toEqual({ ok: true });
    expect(user.agents).toEqual({
      resume: { batch: 2 },
      rotation_defer_max_hours: 24,
    });
    expect(
      cliRows.patchCliRows(user, { agents_rotation: { defer_max_hours: 0 } })
        .ok,
    ).toBe(false);
  });
});


describe("issue 765: doctor flags a wrong agents.rotation_defer_max_hours", () => {
  it("names the value and the 168 h Den uses instead; quiet when unset or right", () => {
    const of = (v: unknown) => () =>
      ({ agents: { rotation_defer_max_hours: v } }) as never;
    expect(rotationDeferMaxBad(of("7d"))).toEqual([
      'config/local/user.yml: agents.rotation_defer_max_hours is "7d", not a number of hours from 1 to 8760: Den uses 168 h (7 days) until it is fixed',
    ]);
    expect(rotationDeferMaxBad(of(0))).toHaveLength(1);
    expect(rotationDeferMaxBad(of(24))).toEqual([]);
    expect(rotationDeferMaxBad(() => ({}) as never)).toEqual([]);
    expect(deprecatedKeys(of("7d")).join("\n")).toMatch(
      /rotation_defer_max_hours is "7d"/,
    );
  });
});
