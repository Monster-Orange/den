/**
 * SRV-1b: the watch over an update (update-watch.mjs), run as it runs in
 * a distribution: `node watch.mjs plan.json`. A fake /api/server-info in
 * this process; npm and the restart are tiny node commands that leave a
 * file. No real npm, no real Den.
 */
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import { spawn } from "child_process";
import * as fs from "fs";
import * as http from "http";
import type { AddressInfo } from "net";
import * as os from "os";
import * as path from "path";

const WATCH = path.resolve(__dirname, "../../../src/ui/server/update-watch.mjs");
const NODE = process.execPath;

let tmp: string;
let server: http.Server;
let port: number;
let answer: () => { pid: number; version: string } | null;

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "den-watch-"));
  answer = () => null;
  server = http.createServer((req, res) => {
    const a = req.url === "/api/server-info" ? answer() : null;
    if (!a) return void res.writeHead(503).end();
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(a));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
});
afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** A command that writes `file` and exits `code`. */
const touch = (file: string, code = 0) => [
  NODE,
  "-e",
  `require("fs").writeFileSync(${JSON.stringify(file)}, "x"); process.exit(${code})`,
];

function plan(over: Record<string, unknown> = {}) {
  const root = path.join(tmp, "dist");
  fs.mkdirSync(root, { recursive: true });
  const pkg = path.join(root, "package.json");
  fs.writeFileSync(pkg, '{"to":"1.1.0"}');
  const saved = path.join(tmp, "package.json.1.0.0");
  fs.writeFileSync(saved, '{"from":"1.0.0"}');
  const p = {
    port,
    from: "1.0.0",
    to: "1.1.0",
    fromPid: 1111,
    waitMs: 1500,
    pollMs: 50,
    root,
    backups: [
      { saved, path: pkg },
      { saved: null, path: path.join(root, "package-lock.json") },
    ],
    npm: touch(path.join(tmp, "npm-ran")),
    restart: touch(path.join(tmp, "restarted")),
    stateFile: path.join(tmp, "state.json"),
    restartMarker: {
      path: path.join(tmp, "restart.json"),
      marker: { id: "ap_1", agent: "server", reason: "update Den 1.0.0 → 1.1.0" },
    },
    ...over,
  };
  const file = path.join(tmp, "plan.json");
  fs.writeFileSync(file, JSON.stringify(p));
  return { file, p, pkg };
}

function runWatch(file: string): Promise<number | null> {
  return new Promise((resolve) => {
    const c = spawn(NODE, [WATCH, file], { stdio: "ignore" });
    c.on("exit", (code) => resolve(code));
  });
}
const state = () =>
  JSON.parse(fs.readFileSync(path.join(tmp, "state.json"), "utf8")) as {
    state: string;
    why?: string;
    pid?: number;
  };

describe("update-watch.mjs (SRV-1b)", () => {
  it("the new version up from a new pid: good, and nothing else runs", async () => {
    answer = () => ({ pid: 2222, version: "1.1.0" });
    const { file } = plan();
    expect(await runWatch(file)).toBe(0);
    expect(state()).toMatchObject({ state: "good", pid: 2222 });
    expect(fs.existsSync(path.join(tmp, "npm-ran"))).toBe(false);
    expect(fs.existsSync(path.join(tmp, "restarted"))).toBe(false);
  });

  it("not up in time: the pin goes back, npm installs the old one, Den restarts on it and is told why", async () => {
    const restarted = path.join(tmp, "restarted");
    // The old server stays (the new one never came up), until the restart.
    answer = () =>
      fs.existsSync(restarted)
        ? { pid: 3333, version: "1.0.0" }
        : { pid: 1111, version: "1.0.0" };
    const { file, pkg, p } = plan();
    fs.writeFileSync(p.backups[1].path, "{}"); // a lock the new install made
    expect(await runWatch(file)).toBe(0);
    expect(fs.readFileSync(pkg, "utf8")).toBe('{"from":"1.0.0"}');
    expect(fs.existsSync(p.backups[1].path)).toBe(false);
    expect(fs.existsSync(path.join(tmp, "npm-ran"))).toBe(true);
    expect(fs.existsSync(restarted)).toBe(true);
    expect(state()).toMatchObject({ state: "rolled_back", pid: 3333 });
    // Gate 0.4.44-dev.0: the old server answering is not the new one.
    expect(state().why).toMatch(
      /^Den 1\.1\.0 wasn't up within 2 s \(nothing new answered on its port\)$/,
    );
    const marker = JSON.parse(fs.readFileSync(p.restartMarker.path, "utf8"));
    expect(marker).toMatchObject({
      id: "ap_1",
      agent: "server",
      fromVersion: "1.1.0",
      fromPid: 0,
      rolledBack: true,
    });
    expect(marker.reason).toMatch(/, so Den rolled back to 1\.0\.0$/);
  });

  it("a new server that answers another version: named, with its own pid", async () => {
    const restarted = path.join(tmp, "restarted");
    answer = () =>
      fs.existsSync(restarted)
        ? { pid: 3333, version: "1.0.0" }
        : { pid: 2222, version: "1.0.9" };
    const { file, p } = plan();
    expect(await runWatch(file)).toBe(0);
    expect(state().why).toMatch(/\(it answered 1\.0\.9 \(pid 2222\)\)$/);
    const marker = JSON.parse(fs.readFileSync(p.restartMarker.path, "utf8"));
    expect(marker.fromPid).toBe(2222);
  });

  it("npm can't put the old one back: rollback_failed, saying why, and no restart", async () => {
    answer = () => null;
    const { file } = plan({ npm: touch(path.join(tmp, "npm-ran"), 3) });
    expect(await runWatch(file)).toBe(1);
    expect(state().state).toBe("rollback_failed");
    expect(state().why).toMatch(/nothing new answered on its port\); npm install of 1\.0\.0 failed/);
    expect(fs.existsSync(path.join(tmp, "restarted"))).toBe(false);
  });

  it("the old one doesn't come back either: rollback_failed", async () => {
    answer = () => ({ pid: 1111, version: "1.1.0-broken" });
    const { file } = plan();
    expect(await runWatch(file)).toBe(1);
    expect(state().state).toBe("rollback_failed");
  });
});
