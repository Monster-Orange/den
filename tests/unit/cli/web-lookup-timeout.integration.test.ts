/**
 * `<cli> web down|restart` when lsof and ps never answer in time (a busy
 * machine): "couldn't tell", exit 1, and the server left as it was. Never
 * "not running", never `stopped: true`, never `ok: true` from a restart
 * that didn't happen (0.4.29-dev.1's and dev.2's gates).
 *
 * Real bin/den in a throwaway distribution, against a stand-in server run
 * from that distribution that says it is ours (/api/server-info). lsof and
 * ps on PATH are shims that answer after 1 s; DEN_LOOKUP_TIMEOUTS_MS gives
 * each lookup 200 ms then 300 ms, so every lookup times out. As on a busy
 * machine, once a lookup has run the server is slow too: its server-info
 * answers after 3 s (the probe waits 1.5 s), so a probe can't see it.
 */
import { afterAll, afterEach, describe, expect, it } from "@jest/globals";
import { spawnSync, type ChildProcess } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawnServer, stopServer } from "../../child-servers.js";

const ENGINE = path.resolve(__dirname, "../../..");
const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "den-web-lookup-"));

function write(file: string, content: string, mode?: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  if (mode) fs.chmodSync(file, mode);
}

const ROOT = path.join(tmpBase, "dist");
write(path.join(ROOT, "den.yml"), "product:\n  name: den\n");
write(path.join(ROOT, "config", "den.yml"), "environments: [local]\n");

// Slow lsof and ps: each answers after 1 s (the real one, then), and
// marks the machine busy for the stand-in server.
const SLOW = path.join(tmpBase, "slow-bin");
const BUSY = path.join(tmpBase, "busy");
for (const [tool, real] of [
  ["lsof", "lsof"],
  ["ps", "ps"],
] as const) {
  const found = spawnSync("sh", ["-c", `command -v ${real}`], {
    encoding: "utf-8",
  }).stdout.trim();
  write(
    path.join(SLOW, tool),
    `#!/bin/sh\n: > "${BUSY}"\nsleep 1\nexec ${found || `/bin/${real}`} "$@"\n`,
    0o755,
  );
}

const FAKE = path.join(tmpBase, "fake-server.cjs");
write(
  FAKE,
  `const http = require("http");
const fs = require("fs");
const info = JSON.parse(process.env.FAKE_INFO);
const s = http.createServer((req, res) => {
  if (req.url === "/api/server-info") {
    const send = () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ pid: process.pid, ...info }));
    };
    return fs.existsSync(process.env.FAKE_BUSY) ? setTimeout(send, 3000) : send();
  }
  if (req.url === "/api/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end("[]");
  }
  if (req.url === "/index.html") {
    res.writeHead(200, { "Content-Type": "text/html" });
    return res.end('<html><head><meta name="den-ui" content="1"></head></html>');
  }
  res.writeHead(404);
  res.end();
});
s.listen(0, "127.0.0.1", () => console.log("PORT " + s.address().port));
`,
);

interface Fake {
  child: ChildProcess;
  port: number;
}
const fakes: Fake[] = [];

/** The stand-in, run from our distribution, saying it is ours. */
async function startOurs(): Promise<Fake> {
  const child = spawnServer(
    process.execPath,
    [FAKE, path.join(ENGINE, "src/ui/server/index.ts")],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        FAKE_BUSY: BUSY,
        FAKE_INFO: JSON.stringify({
          version: "9.9.9",
          root: ROOT,
          product: "den",
        }),
      },
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
  const port = await new Promise<number>((resolve, reject) => {
    let out = "";
    child.stdout!.on("data", (d: Buffer) => {
      out += d.toString();
      const m = /PORT (\d+)/.exec(out);
      if (m) resolve(Number(m[1]));
    });
    child.on("exit", (c) => reject(new Error(`fake server exited ${c}`)));
  });
  const fake = { child, port };
  fakes.push(fake);
  return fake;
}

const alive = (f: Fake) =>
  f.child.exitCode === null && f.child.signalCode === null;

/** `bin/den web <args>` with the slow lookups; stdout, all output, status. */
function den(args: string[]): {
  stdout: string;
  out: string;
  status: number | null;
} {
  const r = spawnSync(path.join(ENGINE, "bin", "den"), ["web", ...args], {
    cwd: ROOT,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      PATH: `${SLOW}${path.delimiter}${process.env.PATH ?? ""}`,
      DEN_LOOKUP_TIMEOUTS_MS: "200,300",
      DEN_ROOT: ROOT,
      DEN_HOME: path.join(ROOT, "home"),
      FORCE_COLOR: "0",
      NO_COLOR: "1",
    },
    timeout: 90_000,
  });
  return {
    stdout: r.stdout,
    out: `${r.stdout}${r.stderr}`,
    status: r.status,
  };
}

const lastJson = (s: string) =>
  JSON.parse(s.trim().split("\n").filter(Boolean).pop() ?? "{}") as Record<
    string,
    unknown
  >;

afterEach(async () => {
  for (const f of fakes.splice(0)) await stopServer(f.child, 0);
  fs.rmSync(BUSY, { force: true });
});

afterAll(() => {
  fs.rmSync(tmpBase, { recursive: true, force: true });
});

describe("web down/restart when lsof and ps never answer in time", () => {
  it("down: couldn't tell, exit 1, the server left running", async () => {
    const fake = await startOurs();
    const { out, status } = den(["down", "--port", `${fake.port}`]);
    expect(out).toContain(
      `Couldn't tell whether Den web is running on port ${fake.port}`,
    );
    expect(out).toMatch(/took too long to answer/);
    expect(out).not.toMatch(/is not running/);
    expect(status).toBe(1);
    expect(alive(fake)).toBe(true);
  }, 120_000);

  it("down --json: ok false, running unknown or true, never stopped", async () => {
    const fake = await startOurs();
    const { stdout, status } = den([
      "down",
      "--json",
      "--port",
      `${fake.port}`,
    ]);
    const j = lastJson(stdout);
    expect(j.ok).toBe(false);
    expect(j.stopped).toBe(false);
    expect(j.running === null || j.running === true).toBe(true);
    expect(String(j.error)).toMatch(/Couldn't tell whether Den web/);
    expect(status).toBe(1);
    expect(alive(fake)).toBe(true);
  }, 120_000);

  it("restart: the same words, exit 1, the same server", async () => {
    const fake = await startOurs();
    const pid = fake.child.pid;
    const { out, status } = den([
      "restart",
      "--no-open",
      "--port",
      `${fake.port}`,
    ]);
    expect(out).toContain(
      `Couldn't tell whether Den web is running on port ${fake.port}`,
    );
    expect(status).toBe(1);
    expect(alive(fake)).toBe(true);
    expect(fake.child.pid).toBe(pid);
  }, 120_000);

  it("restart --json: ok false with the error, though the old server still answers", async () => {
    const fake = await startOurs();
    const { stdout, status } = den([
      "restart",
      "--no-open",
      "--json",
      "--port",
      `${fake.port}`,
    ]);
    const j = lastJson(stdout);
    expect(j.ok).toBe(false);
    expect(String(j.error)).toMatch(/Couldn't tell whether Den web/);
    expect(status).toBe(1);
    expect(alive(fake)).toBe(true);
  }, 120_000);
});
