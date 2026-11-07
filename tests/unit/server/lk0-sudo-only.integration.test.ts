/**
 * LK-0 (Ward, 2026-11-06): the admin password is for sudo, and nothing
 * else. On the real web server, with no password set and a sudo that
 * needs one:
 *
 *   - an agent starts, stops and resumes: no 423, nothing asks;
 *   - a service with no elevated steps starts and stops, and its run
 *     carries no needs-sudo event;
 *   - a service whose `up` runs sudo answers needs-sudo, naming the
 *     command and the service, and its command doesn't run; after the
 *     password is set, the same run runs it;
 *   - Forget drops the password again (Settings' row).
 *
 * The demo distribution (acme) with a scripted PTY and PATH shims
 * (helpers/agents-page-server.ts): the `sudo` shim takes one invented
 * password on stdin and is never a real sudo; nothing prints it.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as http from "http";
import { denAuth } from "./helpers/den-auth.js";
import {
  startAgentsPageServer,
  type AgentsPageServer,
} from "./helpers/agents-page-server.js";

// An invented password the sudo shim takes; it is no one's.
const PW = "open-sesame-test";

let s: AgentsPageServer;

beforeAll(async () => {
  s = await startAgentsPageServer({ sudoPassword: PW, elevatedUp: true });
}, 60_000);

afterAll(async () => {
  await s?.stop();
});

async function call(
  method: string,
  p: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const r = await fetch(`${s.base}${p}`, {
    method,
    headers: {
      ...denAuth(s.stateDir),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await r.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    /* not JSON */
  }
  return { status: r.status, json };
}

/** An SSE run's events, until its `done` (or the stream ends). */
function run(p: string): Promise<Record<string, unknown>[]> {
  return new Promise((resolve, reject) => {
    const events: Record<string, unknown>[] = [];
    const req = http.get(
      {
        host: "localhost",
        port: s.port,
        path: p,
        agent: false,
        headers: { ...denAuth(s.stateDir), accept: "text/event-stream" },
      },
      (res) => {
        let buf = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => {
          buf += c;
          let i;
          while ((i = buf.indexOf("\n\n")) >= 0) {
            const frame = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const data = frame
              .split("\n")
              .filter((l) => l.startsWith("data: "))
              .map((l) => l.slice(6))
              .join("\n");
            if (!data) continue;
            const ev = JSON.parse(data) as Record<string, unknown>;
            events.push(ev);
            if (ev.type === "done") {
              req.destroy();
              resolve(events);
            }
          }
        });
        res.on("end", () => resolve(events));
        res.on("error", reject);
      },
    );
    req.on("error", (e) => (events.length ? resolve(events) : reject(e)));
    req.setTimeout(30_000, () => {
      req.destroy();
      reject(new Error(`no done from ${p}: ${JSON.stringify(events)}`));
    });
  });
}

const exec = (ws: string, cmd: string, address: string) =>
  run(
    `/api/workspace/exec?cmd=${cmd}&workspace=${ws}&addresses=${encodeURIComponent(address)}`,
  );
const needs = (evs: Record<string, unknown>[]) =>
  evs.filter((e) => e.type === "needs-sudo");

describe("LK-0: with no admin password set, nothing that runs no sudo asks for it", () => {
  it("sudo needs a password here, and none is set", async () => {
    const st = await call("GET", "/api/sudo-password/status");
    expect(st.json).toMatchObject({
      set: false,
      passwordless: false,
      saved: null,
    });
  });

  it("an agent starts, stops and resumes (no 423)", async () => {
    const start = await call("POST", "/api/workspaces/north/agents", {
      persona: "planner",
    });
    expect(start.status).toBe(200);
    expect(s.made).toHaveLength(1);
    // The scripted runtime ends on TERM, as a stopped one would; stop
    // answers once it has (0.4.8).
    const kill = s.made[0].kill.bind(s.made[0]);
    s.made[0].kill = (sig: string) => {
      kill(sig);
      setTimeout(() => s.made[0].exit(143), 50);
    };
    const stop = await call(
      "POST",
      "/api/workspaces/north/agents/planner/stop",
    );
    expect(stop.status).toBe(200);
    expect(stop.json).toMatchObject({
      ok: true,
      agent: "planner",
      stopped: true,
    });
    const resume = await call(
      "POST",
      "/api/workspaces/north/agents/planner/resume",
    );
    expect(resume.status).toBe(200);
    expect(s.made).toHaveLength(2);
    await call("POST", "/api/workspaces/north/agents/planner/stop");
  }, 30_000);

  it("a service with no elevated steps starts and stops, and its run says nothing about sudo", async () => {
    for (const cmd of ["up", "down"]) {
      const evs = await exec("north", cmd, "notes");
      expect(needs(evs)).toEqual([]);
      expect(evs.at(-1)).toMatchObject({ type: "done", exitCode: 0 });
    }
  }, 60_000);
});

describe("LK-0: a command that runs sudo asks, naming the command, then runs after the password", () => {
  it("with no password: needs-sudo with the command and the service; the command didn't run", async () => {
    const evs = await exec("south", "up", "blog");
    expect(needs(evs)).toEqual([
      {
        type: "needs-sudo",
        command: `sudo touch ${s.elevated}`,
        step: "blog",
      },
    ]);
    expect(fs.existsSync(s.elevated)).toBe(false);
  }, 60_000);

  it("after the password, the same run runs it, and asks nothing", async () => {
    const set = await call("POST", "/api/sudo-password", { password: PW });
    expect(set.status).toBe(200);
    expect((await call("GET", "/api/sudo-password/status")).json).toMatchObject(
      { set: true, saved: "session" },
    );
    const evs = await exec("south", "up", "blog");
    expect(needs(evs)).toEqual([]);
    expect(fs.existsSync(s.elevated)).toBe(true);
    await exec("south", "down", "blog");
  }, 60_000);

  it("Forget drops it: not saved, and sudo asks again", async () => {
    const r = await call("POST", "/api/sudo-password/forget", {});
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: true, vaultCleared: false });
    expect((await call("GET", "/api/sudo-password/status")).json).toMatchObject(
      { set: false, saved: null },
    );
    fs.rmSync(s.elevated, { force: true });
    const evs = await exec("south", "up", "blog");
    expect(needs(evs)).toHaveLength(1);
    expect(fs.existsSync(s.elevated)).toBe(false);
  }, 60_000);

  it("never prints the password", () => {
    expect(s.log().includes(PW)).toBe(false);
  });
});
