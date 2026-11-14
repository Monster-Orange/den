/**
 * den#85: the real web server, started as a service manager would start it
 * (DEN_CRASH_LOOP_GUARD=1), after starts that never stopped cleanly. It
 * waits before it serves, rings the bell, and records its own start; a
 * SIGTERM stop marks that start clean, so the next start doesn't count it.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { type ChildProcess } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { startDenServer, stopServer } from "../../child-servers.js";

const ENGINE = process.cwd();
const TSX = path.join(ENGINE, "node_modules", ".bin", "tsx");
let tmp = "";
let stateDir = "";
let server: ChildProcess | null = null;
let out: () => string = () => "";
let tookMs = 0;

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

const bootsFile = (): string => path.join(stateDir, "web-boots.json");
const boots = (): { pid: number; clean?: boolean }[] =>
  JSON.parse(fs.readFileSync(bootsFile(), "utf-8"));

beforeAll(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-crash-")));
  const root = path.join(tmp, "dist");
  stateDir = path.join(tmp, "home", ".den");
  write(path.join(root, "den.yml"), "product:\n  name: den\n");
  write(
    path.join(root, "config", "den.yml"),
    "environments: [local]\nedge:\n  org: acme\n  domain: acme.localhost\n  tls: none\n",
  );
  write(
    path.join(root, "config", "local", "user.yml"),
    "web:\n  crash_loop_restarts: 2\n  crash_loop_minutes: 10\n  crash_loop_max_wait_seconds: 3\n",
  );
  const now = Date.now();
  write(
    bootsFile(),
    JSON.stringify([
      { at: new Date(now - 60_000).toISOString(), pid: 999_991 },
      { at: new Date(now - 30_000).toISOString(), pid: 999_992 },
    ]),
  );
  const t0 = Date.now();
  const started = await startDenServer(
    TSX,
    [path.join(ENGINE, "src", "ui", "server", "index.ts")],
    {
      cwd: root,
      env: {
        ...process.env,
        DEN_ROOT: root,
        DEN_ENGINE_ROOT: ENGINE,
        DEN_EDGE_DIR: path.join(tmp, "edge-state"),
        DEN_HOME: stateDir,
        HOME: path.join(tmp, "home"),
        DEN_NO_OPEN: "1",
        NO_COLOR: "1",
        DEN_CRASH_LOOP_GUARD: "1",
      },
    },
    { timeoutMs: 40_000 },
  );
  tookMs = Date.now() - t0;
  server = started.server;
  out = started.out;
}, 60_000);

afterAll(async () => {
  await stopServer(server);
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("the web app's crash-loop guard (den#85)", () => {
  it("waits before it serves, and says why", () => {
    expect(tookMs).toBeGreaterThanOrEqual(3000);
    expect(out()).toMatch(/stopped 2 times in 10 minutes .*waits 3 s/);
  });

  it("rings the bell", () => {
    const f = JSON.parse(
      fs.readFileSync(path.join(stateDir, "notifications.json"), "utf-8"),
    ) as { items: { kind: string; subject: string; msg?: { key: string } }[] };
    expect(f.items).toContainEqual(
      expect.objectContaining({
        kind: "service",
        subject: "record:den-web-crash-loop",
        msg: expect.objectContaining({ key: "bell.m.crashLoop" }),
      }),
    );
  });

  it("records its start, and a SIGTERM stop marks it clean", async () => {
    const pid = server!.pid!;
    expect(boots().map((b) => !!b.clean)).toEqual([false, false, false]);
    await stopServer(server);
    server = null;
    const mine = boots().at(-1)!;
    expect(mine.clean).toBe(true);
    expect(mine.pid).not.toBe(999_992);
    expect(typeof pid).toBe("number");
  });
});
