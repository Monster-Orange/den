/**
 * Issue 1395 (Reviewer A): the Settings page's save writes the gate's
 * settings first, under the gate-slot lock, and user.yml only after. While
 * another process holds that lock past the wait, a save with a gate key
 * and a user.yml key answers 503 and changes neither file; once the lock
 * is free the same save writes both. A real server on a temp distribution
 * and its own gates folder. No code or secret is printed. Invented names
 * only.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import type { ChildProcess } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { startDenServer, stopServer } from "../../child-servers.js";
import { denAuth } from "./helpers/den-auth.js";

const ENGINE = path.resolve(__dirname, "../../..");
const TSX = path.join(ENGINE, "node_modules", ".bin", "tsx");
const AGENT_KEYS = [
  "DEN_AGENT",
  "DEN_ACTOR_TOKEN",
  "DEN_ACTOR_TOKEN_FILE",
  "DEN_HOME",
  "DEN_TEST_INSTALL",
];

let tmp = "";
let root = "";
let stateDir = "";
let gates = "";
let base = "";
let server: ChildProcess | undefined;

beforeAll(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-1395-")));
  root = path.join(tmp, "dist");
  stateDir = path.join(tmp, "state");
  gates = path.join(tmp, "gates");
  const home = path.join(tmp, "home");
  fs.mkdirSync(path.join(root, "config"), { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(gates, { recursive: true });
  fs.writeFileSync(path.join(root, "den.yml"), "product:\n  name: den\n");
  fs.writeFileSync(
    path.join(root, "config", "den.yml"),
    "environments: [local]\n",
  );
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of AGENT_KEYS) delete env[k];
  const s = await startDenServer(
    TSX,
    [path.join(ENGINE, "src", "ui", "server", "index.ts"), "--silent"],
    {
      cwd: root,
      stdio: ["ignore", "ignore", "inherit"],
      env: {
        ...env,
        DEN_ROOT: root,
        DEN_ENGINE_ROOT: ENGINE,
        HOME: home,
        DEN_HOME: stateDir,
        DEN_GATE_DIR: gates,
        DEN_NO_OPEN: "1",
        NO_COLOR: "1",
      },
    },
    { timeoutMs: 40_000 },
  );
  server = s.server;
  base = `http://localhost:${s.port}`;
}, 60_000);

afterAll(async () => {
  if (server) await stopServer(server);
  fs.rmSync(tmp, { recursive: true, force: true });
});

const userYml = () => {
  const f = path.join(root, "config", "local", "user.yml");
  return fs.existsSync(f) ? fs.readFileSync(f, "utf-8") : "";
};
const gateFile = () => {
  const f = path.join(gates, "settings.json");
  return fs.existsSync(f) ? fs.readFileSync(f, "utf-8") : "";
};
const save = async (body: Record<string, unknown>) => {
  const r = await fetch(`${base}/api/settings`, {
    method: "POST",
    headers: { ...denAuth(stateDir), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return {
    status: r.status,
    json: (await r.json().catch(() => ({}))) as Record<string, unknown>,
  };
};

describe("issue 1395: a Settings save never half-saves on a busy gate lock", () => {
  it("lock held: 503, and neither user.yml nor the gate's settings change; lock free: both are written", async () => {
    const body = { gate_slots: { cpu_slots: 3 }, log_window_lines: 7777 };
    const beforeUser = userYml();
    const beforeGate = gateFile();
    // Another live process (this one) holds the gate-slot lock.
    const lock = path.join(gates, "lock");
    fs.mkdirSync(lock);
    fs.writeFileSync(path.join(lock, "pid"), String(process.pid));
    try {
      const r = await save(body);
      expect(userYml()).toBe(beforeUser);
      expect(gateFile()).toBe(beforeGate);
      expect(r.status).toBe(503);
      expect(String(r.json.error)).toMatch(/lock.*nothing was saved/);
    } finally {
      fs.rmSync(lock, { recursive: true, force: true });
    }
    const ok = await save(body);
    expect(ok.status).toBe(200);
    expect(userYml()).toMatch(/log_window_lines: 7777/);
    expect(JSON.parse(gateFile()).cpu_slots).toBe(3);
  }, 60_000);
});
