/**
 * D55: a restart finishes on the server whatever its page does. On the
 * real web server (the demo distribution, helpers/agents-page-server.ts),
 * a workspace restart whose `down` takes a moment:
 *
 *   - the page's stream closes during the down: the up still runs;
 *   - a page that comes back finds the run in /api/exec/jobs and attaches
 *     to it: the events so far, then the rest, to its done;
 *   - Stop (POST /api/exec/jobs/:id/stop) stops it: no up, and a done
 *     that says it was stopped;
 *   - a service's own down (/api/service/exec) goes on the same way. (Its
 *     restart already did: the runner's down-then-up never stops for a
 *     closed stream, only its log tail does.)
 *
 * Invented names only; every command is a shell `sleep` or `touch` in the
 * test's temp dir.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import { denAuth } from "./helpers/den-auth.js";
import {
  startAgentsPageServer,
  type AgentsPageServer,
} from "./helpers/agents-page-server.js";

let s: AgentsPageServer;
let tmp: string;
let health: http.Server;
const upRan = () => path.join(tmp, "up-ran");

beforeAll(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-d55-")));
  const running = path.join(tmp, "running");
  // notes' health check: up while its `running` file is there.
  health = http.createServer((_req, res) => {
    res.writeHead(fs.existsSync(running) ? 200 : 503);
    res.end();
  });
  await new Promise<void>((r) => health.listen(0, "127.0.0.1", () => r()));
  const port = (health.address() as { port: number }).port;
  s = await startAgentsPageServer({
    root: tmp,
    health: { notes: `http://127.0.0.1:${port}/health` },
    // A dev server: it marks that it started, then runs until stopped.
    up: { notes: `touch ${upRan()} ${running}; exec sleep 300` },
    // A stop that takes a moment.
    down: { notes: `sleep 2; rm -f ${running}` },
  });
  // Running, so a restart has a down to do.
  await stream(
    "/api/workspace/exec?cmd=up&workspace=north&addresses=notes",
    (ev) => ev.type === "done",
  );
}, 60_000);

afterAll(async () => {
  await stream(
    "/api/workspace/exec?cmd=down&workspace=north&addresses=notes",
    (ev) => ev.type === "done",
  ).catch(() => []);
  await s?.stop();
  await new Promise((r) => health?.close(r));
});

type Ev = Record<string, unknown>;

/**
 * An SSE stream's events. `until` says when to stop reading: on the event
 * that makes it true the request is destroyed, as a closed tab's would be.
 */
function stream(
  p: string,
  until: (ev: Ev, all: Ev[]) => boolean,
): Promise<Ev[]> {
  return new Promise((resolve, reject) => {
    const events: Ev[] = [];
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
            const ev = JSON.parse(data) as Ev;
            events.push(ev);
            if (until(ev, events)) {
              req.destroy();
              resolve(events);
              return;
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
      reject(new Error(`timed out on ${p}: ${JSON.stringify(events)}`));
    });
  });
}

async function call(
  method: string,
  p: string,
): Promise<{ status: number; json: Ev }> {
  const r = await fetch(`${s.base}${p}`, {
    method,
    headers: {
      ...denAuth(s.stateDir),
      ...(method === "POST" ? { "content-type": "application/json" } : {}),
    },
    ...(method === "POST" ? { body: "{}" } : {}),
  });
  const text = await r.text();
  let json: Ev = {};
  try {
    json = JSON.parse(text) as Ev;
  } catch {
    /* not JSON */
  }
  return { status: r.status, json };
}

async function waitFor(
  ok: () => boolean | Promise<boolean>,
  ms = 15_000,
): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await ok()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

const restart =
  "/api/workspace/exec?cmd=restart&workspace=north&addresses=notes";
const isDown = (ev: Ev) =>
  ev.type === "line" && /restart: stopping/.test(String(ev.text));

describe("D55: a workspace restart goes on when its page goes", () => {
  it("the stream closes during the down; the up still runs", async () => {
    fs.rmSync(upRan(), { force: true });
    const seen = await stream(restart, isDown);
    expect(seen.some(isDown)).toBe(true);
    expect(fs.existsSync(upRan())).toBe(false);
    expect(await waitFor(() => fs.existsSync(upRan()))).toBe(true);
  }, 40_000);

  it("a page that comes back finds the run and attaches: so far, then to its done", async () => {
    fs.rmSync(upRan(), { force: true });
    const first = await stream(restart, isDown);
    const id = first.find((e) => e.type === "job")?.id;
    expect(typeof id).toBe("string");
    const list = await call("GET", "/api/exec/jobs");
    expect(list.status).toBe(200);
    const mine = (list.json.jobs as Ev[]).find((j) => j.id === id);
    expect(mine).toMatchObject({
      path: "/api/workspace/exec",
      status: "running",
      params: { cmd: "restart", workspace: "north", addresses: "notes" },
    });
    const again = await stream(
      `/api/exec/jobs/${String(id)}/events`,
      (ev) => ev.type === "done",
    );
    // The replay: the same start, and the same down line, then the rest.
    expect(again[0]).toEqual({ type: "job", id });
    expect(again.filter(isDown)).toHaveLength(1);
    expect(again.at(-1)).toMatchObject({ type: "done", exitCode: 0 });
    expect(fs.existsSync(upRan())).toBe(true);
    const after = await call("GET", `/api/exec/jobs/${String(id)}`);
    expect(after.json).toMatchObject({
      status: "done",
      exitCode: 0,
      stopped: false,
    });
  }, 40_000);

  it("a finished run still replays whole, to a page that comes back late", async () => {
    const list = await call("GET", "/api/exec/jobs");
    const done = (list.json.jobs as Ev[]).find((j) => j.status === "done");
    expect(done).toBeTruthy();
    const all = await stream(
      `/api/exec/jobs/${String(done!.id)}/events`,
      () => false,
    );
    expect(all[0]).toMatchObject({ type: "job" });
    expect(all.at(-1)).toMatchObject({ type: "done" });
  }, 20_000);

  it("Stop stops it: no up, and a done that says stopped", async () => {
    fs.rmSync(upRan(), { force: true });
    const first = await stream(restart, isDown);
    const id = String(first.find((e) => e.type === "job")?.id);
    const watching = stream(
      `/api/exec/jobs/${id}/events`,
      (ev) => ev.type === "done",
    );
    const r = await call("POST", `/api/exec/jobs/${id}/stop`);
    expect(r).toMatchObject({
      status: 200,
      json: { ok: true, outcome: "stopped" },
    });
    const seen = await watching;
    expect(seen.at(-1)).toMatchObject({
      type: "done",
      exitCode: 130,
      stopped: true,
    });
    // The down was killed and nothing went on to the up.
    await new Promise((res) => setTimeout(res, 3000));
    expect(fs.existsSync(upRan())).toBe(false);
    expect(
      (await call("POST", `/api/exec/jobs/${id}/stop`)).json,
    ).toMatchObject({
      outcome: "ended",
    });
  }, 40_000);

  it("an unknown run is a 404, on each of its routes", async () => {
    expect((await call("GET", "/api/exec/jobs/run_nope")).status).toBe(404);
    expect((await call("GET", "/api/exec/jobs/run_nope/events")).status).toBe(
      404,
    );
    expect((await call("POST", "/api/exec/jobs/run_nope/stop")).status).toBe(
      404,
    );
  });
});

describe("D55: a service's own run goes on the same way", () => {
  it("its down: the stream closes while it stops; the stop still finishes", async () => {
    const running = path.join(tmp, "running");
    expect(fs.existsSync(running)).toBe(true);
    const seen = await stream(
      "/api/service/exec?repo=notes&service=notes&cmd=down&workspace=north",
      (ev) => ev.type === "job",
    );
    const id = String(seen[0]?.id);
    expect(fs.existsSync(running)).toBe(true);
    expect(await waitFor(() => !fs.existsSync(running))).toBe(true);
    expect(
      await waitFor(
        async () =>
          (await call("GET", `/api/exec/jobs/${id}`)).json.status === "done",
      ),
    ).toBe(true);
    expect((await call("GET", `/api/exec/jobs/${id}`)).json).toMatchObject({
      path: "/api/service/exec",
      exitCode: 0,
      stopped: false,
    });
  }, 40_000);
});
