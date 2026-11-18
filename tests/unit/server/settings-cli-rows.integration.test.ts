/**
 * MODE-5 (0.4.46): what only the command line could change, from
 * Settings: Local environment, Terminal tabs, Log pane lines, the
 * terminals' reconnect limits (panes.*) and the restart guard
 * (web.crash_loop_*). POST /api/settings writes user.yml; null clears
 * (back to the default). A person's only: an agent's claim is refused and
 * changes nothing. Out-of-range values are refused.
 *
 * The demo distribution (helpers/agents-page-server.ts). Invented names.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import { parse as parseYaml } from "yaml";
import { denAuth } from "./helpers/den-auth.js";
import {
  startAgentsPageServer,
  type AgentsPageServer,
} from "./helpers/agents-page-server.js";

let s: AgentsPageServer;
beforeAll(async () => {
  s = await startAgentsPageServer();
}, 60_000);
afterAll(async () => {
  await s?.stop();
});

const user = (): Record<string, unknown> =>
  (parseYaml(
    fs.readFileSync(
      path.join(s.tmp, "dist", "config", "local", "user.yml"),
      "utf-8",
    ),
  ) as Record<string, unknown> | null) ?? {};

const asAgent = (body: unknown) =>
  fetch(`${s.base}/api/settings`, {
    method: "POST",
    headers: {
      ...denAuth(s.stateDir),
      "content-type": "application/json",
      "x-den-actor": "agent",
      "x-den-mcp-agent": "agent:planner",
    },
    body: JSON.stringify(body),
  });

describe("MODE-5: Settings rows that were the command line's", () => {
  it("Local environment, Terminal tabs and Log pane lines: set, shown, cleared", async () => {
    expect(
      await s.settings({
        local_dev: false,
        cli_tabs: true,
        log_window_lines: 50_000,
      }),
    ).toBe(200);
    expect(user()).toMatchObject({
      local_dev: false,
      cli_tabs: true,
      log_window_lines: 50_000,
    });
    const g = await s.settingsGet();
    expect(g).toMatchObject({
      local_dev: false,
      cli_tabs: true,
      log_window_lines: 50_000,
    });
    expect(
      await s.settings({
        local_dev: null,
        cli_tabs: null,
        log_window_lines: null,
      }),
    ).toBe(200);
    expect(user()).not.toHaveProperty("local_dev");
    expect(user()).not.toHaveProperty("cli_tabs");
    expect(user()).not.toHaveProperty("log_window_lines");
  });

  it("the terminals' reconnect limits and the restart guard: set one at a time, defaults kept for the rest", async () => {
    expect(await s.settings({ panes_reconnect: { max_failures: 20 } })).toBe(
      200,
    );
    expect(await s.settings({ crash_loop: { restarts: 8 } })).toBe(200);
    expect(user()).toMatchObject({
      panes: { reconnect_max_failures: 20 },
      web: { crash_loop_restarts: 8 },
    });
    const g = await s.settingsGet();
    expect(g.panes_reconnect).toMatchObject({
      max_failures: 20,
      window_seconds: 300,
      max_seconds: 30,
    });
    expect(g.crash_loop).toMatchObject({
      restarts: 8,
      minutes: 10,
      maxWaitSeconds: 300,
    });
    expect(
      await s.settings({
        panes_reconnect: { window_seconds: 600, max_seconds: 60 },
        crash_loop: { minutes: 30, max_wait_seconds: 0 },
      }),
    ).toBe(200);
    expect(user()).toMatchObject({
      panes: {
        reconnect_max_failures: 20,
        reconnect_window_seconds: 600,
        reconnect_max_seconds: 60,
      },
      web: {
        crash_loop_restarts: 8,
        crash_loop_minutes: 30,
        crash_loop_max_wait_seconds: 0,
      },
    });
    // null clears one back to its default.
    expect(
      await s.settings({
        panes_reconnect: { max_failures: null },
        crash_loop: { restarts: null },
      }),
    ).toBe(200);
    expect(
      (user().panes as Record<string, unknown>).reconnect_max_failures,
    ).toBeUndefined();
    expect((await s.settingsGet()).crash_loop).toMatchObject({ restarts: 5 });
  });

  it("out of range, the wrong type or an unknown limit is refused, and nothing is written", async () => {
    const before = JSON.stringify(user());
    for (const bad of [
      { log_window_lines: 10 },
      { log_window_lines: "lots" },
      { local_dev: "no" },
      { cli_tabs: 1 },
      { panes_reconnect: { max_failures: 0 } },
      { panes_reconnect: { max_seconds: -1 } },
      { panes_reconnect: { speed: 3 } },
      { crash_loop: { restarts: 0 } },
      { crash_loop: { minutes: 1.5 } },
      { crash_loop: "off" },
    ])
      expect([bad, await s.settings(bad)]).toEqual([bad, 400]);
    expect(JSON.stringify(user())).toBe(before);
  });

  it("an agent can't change any of them", async () => {
    const before = JSON.stringify(user());
    for (const body of [
      { local_dev: false },
      { cli_tabs: true },
      { log_window_lines: 30_000 },
      { panes_reconnect: { max_failures: 99 } },
      { crash_loop: { restarts: 99 } },
    ]) {
      const r = await asAgent(body);
      expect([body, r.status]).toEqual([body, 403]);
      expect((await r.json()).error).toMatch(/only a person/);
    }
    expect(JSON.stringify(user())).toBe(before);
    // The older route for Local environment is a person's too.
    const r = await fetch(`${s.base}/api/local-dev`, {
      method: "POST",
      headers: {
        ...denAuth(s.stateDir),
        "content-type": "application/json",
        "x-den-actor": "agent",
        "x-den-mcp-agent": "agent:planner",
      },
      body: JSON.stringify({ enabled: false }),
    });
    expect(r.status).toBe(403);
    expect(JSON.stringify(user())).toBe(before);
  });
});

/**
 * Issue 424: a save's reply is what GET says, every key. It left
 * cli_tabs out (and the other rows that were the command line's), so the
 * page redrew Terminal tabs from the old value after saving it, and a
 * second look turned it on and saved it again.
 */
describe("issue 424: the reply to a save carries every key GET has", () => {
  const asPerson = async (method: "GET" | "POST", body?: unknown) => {
    const r = await fetch(`${s.base}/api/settings`, {
      method,
      headers: {
        ...denAuth(s.stateDir),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    expect(r.status).toBe(200);
    return (await r.json()) as Record<string, unknown>;
  };

  it("POST cli_tabs true answers cli_tabs true, and off answers false", async () => {
    expect((await asPerson("POST", { cli_tabs: true })).cli_tabs).toBe(true);
    expect((await asPerson("POST", { cli_tabs: null })).cli_tabs).toBe(false);
  });

  it("the reply's keys are GET's keys, and their values match", async () => {
    const reply = await asPerson("POST", {
      log_window_lines: 40_000,
      panes_reconnect: { max_failures: 12 },
    });
    const got = await asPerson("GET");
    const { ok, ...fields } = reply;
    expect(ok).toBe(true);
    expect(Object.keys(fields).sort()).toEqual(Object.keys(got).sort());
    for (const k of [
      "local_dev",
      "cli_tabs",
      "log_window_lines",
      "panes_reconnect",
      "crash_loop",
    ])
      expect([k, fields[k]]).toEqual([k, got[k]]);
    expect(fields.log_window_lines).toBe(40_000);
    await asPerson("POST", {
      log_window_lines: null,
      panes_reconnect: { max_failures: null },
    });
  });
});
