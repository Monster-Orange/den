/**
 * The web server's SIGTERM shutdown, in an installed distribution (Den in
 * <dist>/node_modules/@monster-orange/den, the dist root found by walking up
 * from the entry script). The shutdown reads the running-services registry,
 * whose path resolves the distribution root again; when that walk fails (the
 * dist's den.yml is gone), the shutdown used to reject unhandled: the server
 * logged "unhandled rejection (continuing): ... cannot locate the
 * distribution root" and, its signal guard already set, never exited.
 *
 * Since 0.2.4 the root is resolved once per process (paths.ts), so the
 * registry no longer re-walks at shutdown at all; the shutdown also catches
 * a failure and still exits. Either way: a clean exit, no rejection.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { spawn, type ChildProcess } from "child_process";
import * as fs from "fs";
import * as http from "http";
import * as net from "net";
import type { AddressInfo } from "net";
import * as os from "os";
import * as path from "path";

const ENGINE = path.resolve(__dirname, "../../..");
let tmp = "";
let dist = "";
let port = 0;
let server: ChildProcess;
let out = "";

function get(p: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { host: "127.0.0.1", port, path: p, timeout: 5_000, agent: false },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      },
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("timeout")));
  });
}

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "den-shutdown-"));
  dist = path.join(tmp, "acme");
  fs.mkdirSync(path.join(dist, "config"), { recursive: true });
  fs.writeFileSync(path.join(dist, "den.yml"), "product:\n  name: acme\n");
  fs.writeFileSync(
    path.join(dist, "config", "acme.yml"),
    "environments: [local]\n",
  );
  // Installed layout: the engine under the dist's node_modules, with what
  // the package ships (no den.yml of its own: Den's checkout has one).
  const scope = path.join(dist, "node_modules", "@monster-orange");
  const installed = path.join(scope, "den");
  fs.mkdirSync(installed, { recursive: true });
  for (const entry of ["package.json", "bin", "src", "node_modules"])
    fs.symlinkSync(path.join(ENGINE, entry), path.join(installed, entry));

  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  port = (s.address() as AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));

  const env: NodeJS.ProcessEnv = { ...process.env };
  // No root from the environment: the walk from the entry script finds it.
  for (const k of Object.keys(env)) if (/_ROOT$/.test(k)) delete env[k];
  delete env.DEN_PROFILE;
  server = spawn(
    path.join(ENGINE, "node_modules", ".bin", "tsx"),
    [path.join(scope, "den", "src", "ui", "server", "index.ts")],
    {
      cwd: dist,
      env: {
        ...env,
        ACME_HOME: path.join(tmp, "home"),
        PORT: String(port),
        DEN_NO_OPEN: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  server.stdout!.on("data", (d: Buffer) => (out += d.toString()));
  server.stderr!.on("data", (d: Buffer) => (out += d.toString()));
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      if ((await get("/api/server-info")) === 200) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`server did not start:\n${out}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}, 30_000);

afterAll(() => {
  if (server && server.exitCode === null) server.kill("SIGKILL");
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("web server shutdown in an installed distribution", () => {
  it("exits on SIGTERM, without an unhandled rejection, when the dist root can no longer be found", async () => {
    // The walk from <dist>/node_modules/@monster-orange/den/src/ui/server
    // now finds no den.yml.
    fs.rmSync(path.join(dist, "den.yml"));

    const exited = new Promise<number | null>((r) =>
      server.once("exit", (code) => r(code)),
    );
    server.kill("SIGTERM");
    const code = await Promise.race([
      exited,
      new Promise<"still running">((r) =>
        setTimeout(() => r("still running"), 8_000).unref(),
      ),
    ]);

    expect(out).not.toMatch(/unhandled rejection/);
    expect(code).not.toBe("still running");
    expect(code).toBe(0);
  }, 20_000);
});
