/**
 * Issue 52 on a real server: the Coach's routes through the request guard.
 * GET /api/coach reads on loopback; Run now needs a person's signed-in
 * session (with CSRF), refuses while the Coach is off, and once it is on
 * saves a report that GET then returns. No agent here, so the report has
 * no rows; the breakdown itself is covered in tests/unit/coach.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { type ChildProcess } from "child_process";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import { startDenServer, stopServer } from "../../child-servers.js";
import { signedIn, type SignedIn } from "./helpers/signed-in.js";

const ENGINE = path.resolve(__dirname, "../../..");
const TSX = path.join(ENGINE, "node_modules", ".bin", "tsx");
const AGENT_KEYS = [
  "DEN_AGENT",
  "DEN_ACTOR_TOKEN",
  "DEN_ACTOR_TOKEN_FILE",
  "DEN_PERSON_TOKEN",
];

let tmp = "";
let root = "";
let stateDir = "";
let base = "";
let server: ChildProcess;
let person: SignedIn;

function call(
  method: string,
  p: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      `${base}${p}`,
      {
        method,
        agent: false,
        timeout: 30_000,
        headers: {
          connection: "close",
          ...(method === "POST"
            ? { "content-type": "application/json", "content-length": "2" }
            : {}),
          ...headers,
        },
      },
      (res) => {
        let buf = "";
        res.on("data", (d: Buffer) => (buf += d.toString()));
        res.on("end", () => {
          let json: Record<string, unknown> = {};
          try {
            json = JSON.parse(buf) as Record<string, unknown>;
          } catch {
            /* not json */
          }
          resolve({ status: res.statusCode ?? 0, json });
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error(`timeout: ${p}`)));
    req.end(method === "POST" ? "{}" : undefined);
  });
}

const setConfig = (extra: string[]) =>
  fs.writeFileSync(
    path.join(root, "config", "den.yml"),
    ["environments: [local]", ...extra, ""].join("\n"),
  );

beforeAll(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-coach52-")));
  root = path.join(tmp, "dist");
  const home = path.join(tmp, "home");
  stateDir = path.join(tmp, "state");
  fs.mkdirSync(path.join(root, "config"), { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(root, "den.yml"), "product:\n  name: den\n");
  setConfig([]);
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of [...AGENT_KEYS, "DEN_HOME", "DEN_TEST_INSTALL"])
    delete env[k];
  const s = await startDenServer(
    TSX,
    [path.join(ENGINE, "src", "ui", "server", "index.ts")],
    {
      cwd: root,
      env: {
        ...env,
        DEN_ROOT: root,
        DEN_ENGINE_ROOT: ENGINE,
        HOME: home,
        DEN_HOME: stateDir,
        DEN_NO_OPEN: "1",
        NO_COLOR: "1",
      },
    },
    { timeoutMs: 40_000 },
  );
  base = `http://localhost:${s.port}`;
  server = s.server;
  person = await signedIn(stateDir, base);
}, 90_000);

afterAll(async () => {
  if (server) await stopServer(server);
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("the Coach's routes on a real server", () => {
  it("GET says the Coach is off by default, with no report yet", async () => {
    const r = await call("GET", "/api/coach");
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({
      ok: true,
      settings: { enabled: false, window_days: 7 },
      report: null,
      running: false,
    });
  });

  it("Run now without a person's sign-in is refused by the guard", async () => {
    const r = await call("POST", "/api/coach/run", { origin: base });
    expect([401, 403]).toContain(r.status);
    expect(fs.existsSync(path.join(stateDir, "coach"))).toBe(false);
  });

  it("a person's Run now while the Coach is off is refused, saying how to turn it on", async () => {
    const r = await call("POST", "/api/coach/run", person.headers);
    expect(r.status).toBe(409);
    expect(r.json).toMatchObject({ ok: false, code: "coach_off" });
  });

  it("turned on, a person's Run now saves a report that GET returns", async () => {
    setConfig([
      "agents:",
      "  coach:",
      "    enabled: true",
      "    window_days: 3",
    ]);
    const r = await call("POST", "/api/coach/run", person.headers);
    expect(r.status).toBe(200);
    const report = r.json.report as {
      window: { days: number };
      agents: unknown[];
    };
    expect(report.window.days).toBe(3);
    expect(report.agents).toEqual([]);
    const g = await call("GET", "/api/coach");
    expect(g.json.report).toEqual(r.json.report);
    expect(fs.existsSync(path.join(stateDir, "coach", "latest.json"))).toBe(
      true,
    );
  });
});
