/**
 * The test helper that starts a Den server (tests/child-servers.ts): "up"
 * means /api/server-info names the test's own root. A port found free can
 * be taken by another test's server before this one binds it; that server
 * answering 200 must never count as ours (runs-dock's "no web.secret").
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import {
  freePort,
  startDenServer,
  stopServer,
  type StartedServer,
} from "../../child-servers.js";

/** A stand-in Den server: answers /api/server-info with its root on PORT. */
const FAKE = `
const http = require("http");
http.createServer((q, s) => {
  s.setHeader("Content-Type", "application/json");
  s.end(JSON.stringify({ root: process.env.DEN_ROOT, pid: process.pid }));
}).listen(Number(process.env.PORT), "localhost");
`;

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0)) await c();
});

function tmpRoot(): string {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-sds-")));
  cleanup.push(async () => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

/** Another test's server, holding `port` and naming another root. */
async function foreign(): Promise<number> {
  const s = http.createServer((_q, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ root: "/somewhere/else", pid: 1 }));
  });
  await new Promise<void>((r) => s.listen(0, "localhost", r));
  cleanup.push(() => new Promise<void>((r) => s.close(() => r())));
  return (s.address() as { port: number }).port;
}

describe("startDenServer", () => {
  it("a port another server took is never ours: it tries another and finds its own", async () => {
    const root = tmpRoot();
    const taken = await foreign();
    const picks = [taken];
    const started: StartedServer = await startDenServer(
      process.execPath,
      ["-e", FAKE],
      { cwd: root, env: { ...process.env, DEN_ROOT: root } },
      { pickPort: async () => picks.shift() ?? freePort(), timeoutMs: 10_000 },
    );
    cleanup.push(() => stopServer(started.server));
    expect(started.port).not.toBe(taken);
    expect(picks).toEqual([]);
  });

  it("a server that exits saying its port is taken (Den's own words, no EADDRINUSE) is tried again on another", async () => {
    const root = tmpRoot();
    // The first start says what Den's server says, and exits; the second
    // is a server of its own.
    const once = path.join(root, "said-taken");
    const script = `
const fs = require("fs");
if (!fs.existsSync(${JSON.stringify(once)})) {
  fs.writeFileSync(${JSON.stringify(once)}, "1");
  console.error("  ✗ Port " + process.env.PORT + " is already in use.");
  process.exit(1);
}
${FAKE}`;
    const started = await startDenServer(
      process.execPath,
      ["-e", script],
      { cwd: root, env: { ...process.env, DEN_ROOT: root } },
      { timeoutMs: 10_000 },
    );
    cleanup.push(() => stopServer(started.server));
    expect(fs.existsSync(once)).toBe(true);
  });

  it("a server that exits for its own reasons fails at once, with what it printed", async () => {
    const root = tmpRoot();
    await expect(
      startDenServer(
        process.execPath,
        ["-e", 'console.error("bad config"); process.exit(1)'],
        { cwd: root, env: { ...process.env, DEN_ROOT: root } },
        { timeoutMs: 10_000 },
      ),
    ).rejects.toThrow(/try 1 on port \d+: it exited\nbad config/);
  });
});
