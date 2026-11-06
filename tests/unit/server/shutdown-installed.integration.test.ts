/**
 * The web server's SIGTERM shutdown, in an installed distribution (Den in
 * <dist>/node_modules/@monster-orange/den, the dist root found by walking up
 * from the entry script), started the way `<cli> web up` starts it
 * (resolveServerEntrypoint).
 *
 * 1. The shutdown reads the running-services registry, whose path resolves
 *    the distribution root again; when that walk failed (the dist's den.yml
 *    gone), the shutdown rejected unhandled and never exited. Since 0.2.4
 *    the root is resolved once per process and the shutdown catches a
 *    failure: a clean exit, no rejection.
 * 2. A SIGTERM must reach the server's own handler however busy it is. The
 *    server used to run under the `tsx` CLI, which relays a signal to its
 *    child and, without an acknowledgement within ~60ms, SIGKILLs it and
 *    exits 143: under load the shutdown never ran. A preloaded busy loop
 *    (the server's event loop blocked 300ms at a time) makes that
 *    deterministic.
 */
import { afterAll, describe, expect, it } from "@jest/globals";
import type { ChildProcess } from "child_process";
import * as fs from "fs";
import * as http from "http";
import * as net from "net";
import type { AddressInfo } from "net";
import * as os from "os";
import * as path from "path";
import { pathToFileURL } from "url";
import { resolveServerEntrypoint } from "../../../src/ui/cli/web-command.js";
import { spawnServer, stopServer } from "../../child-servers.js";

const ENGINE = path.resolve(__dirname, "../../..");
const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "den-shutdown-"));

function get(port: number, p: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { host: "127.0.0.1", port, path: p, timeout: 30_000, agent: false },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      },
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("timeout")));
  });
}

interface Started {
  dist: string;
  server: ChildProcess;
  output: () => string;
}

/** An installed distribution with the server started and answering. */
async function startInstalled(nodeOptions?: string): Promise<Started> {
  const tmp = fs.mkdtempSync(path.join(tmpBase, "case-"));
  const dist = path.join(tmp, "acme");
  fs.mkdirSync(path.join(dist, "config"), { recursive: true });
  fs.writeFileSync(path.join(dist, "den.yml"), "product:\n  name: acme\n");
  fs.writeFileSync(
    path.join(dist, "config", "acme.yml"),
    "environments: [local]\n",
  );
  // Installed layout: the engine under the dist's node_modules, with what
  // the package ships (no den.yml of its own: Den's checkout has one).
  const installed = path.join(dist, "node_modules", "@monster-orange", "den");
  fs.mkdirSync(installed, { recursive: true });
  for (const entry of ["package.json", "bin", "src", "node_modules"])
    fs.symlinkSync(path.join(ENGINE, entry), path.join(installed, entry));

  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));

  const env: NodeJS.ProcessEnv = { ...process.env };
  // No root from the environment: the walk from the entry script finds it.
  for (const k of Object.keys(env)) if (/_ROOT$/.test(k)) delete env[k];
  delete env.DEN_PROFILE;
  const entry = resolveServerEntrypoint(installed);
  let out = "";
  const server = spawnServer(entry.cmd, entry.args, {
    cwd: dist,
    env: {
      ...env,
      ACME_HOME: path.join(tmp, "home"),
      PORT: String(port),
      DEN_NO_OPEN: "1",
      ...(nodeOptions ? { NODE_OPTIONS: nodeOptions } : {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout!.on("data", (d: Buffer) => (out += d.toString()));
  server.stderr!.on("data", (d: Buffer) => (out += d.toString()));
  started.push(server);
  // Generous bounds, not expectations: a loaded machine (load 40+) can take
  // tens of seconds to boot. The loop returns as soon as it answers.
  const deadline = Date.now() + 120_000;
  for (;;) {
    try {
      if ((await get(port, "/api/server-info")) === 200) break;
    } catch {
      /* not up yet */
    }
    if (server.exitCode !== null)
      throw new Error(`server exited ${server.exitCode}:\n${out}`);
    if (Date.now() > deadline) throw new Error(`server did not start:\n${out}`);
    await new Promise((r) => setTimeout(r, 200));
  }
  return { dist, server, output: () => out };
}

/** SIGTERM `server`; its exit code, or "still running" after a minute. */
async function terminate(
  server: ChildProcess,
): Promise<number | null | string> {
  const exited = new Promise<number | null>((r) =>
    server.once("exit", (code) => r(code)),
  );
  server.kill("SIGTERM");
  return Promise.race([
    exited,
    new Promise<string>((r) =>
      setTimeout(() => r("still running"), 60_000).unref(),
    ),
  ]);
}

const started: ChildProcess[] = [];
afterAll(async () => {
  // Each server's whole group, even one a test left running.
  await Promise.all(started.map((s) => stopServer(s, 1_000)));
  fs.rmSync(tmpBase, { recursive: true, force: true });
});

describe("web server shutdown in an installed distribution", () => {
  it("exits on SIGTERM, without an unhandled rejection, when the dist root can no longer be found", async () => {
    const { dist, server, output } = await startInstalled();
    // The walk from <dist>/node_modules/@monster-orange/den/src/ui/server
    // now finds no den.yml.
    fs.rmSync(path.join(dist, "den.yml"));
    const code = await terminate(server);
    expect(output()).not.toMatch(/unhandled rejection/);
    expect(code).toBe(0);
  }, 200_000);

  it("a SIGTERM the moment it is ready reaches its own handler, however busy it is", async () => {
    // Blocks the server's event loop 300ms at a time (not the parent of a
    // relaying wrapper: only the process running the server entry).
    const busy = path.join(tmpBase, "busy.mjs");
    fs.writeFileSync(
      busy,
      [
        'if (/server[\\/]index\\.ts$/.test(process.argv[1] ?? "")) {',
        `  (await import("fs")).writeFileSync(${JSON.stringify(path.join(tmpBase, "busy.on"))}, "");`,
        "  setInterval(() => {",
        "    const t = Date.now();",
        "    while (Date.now() - t < 300) {}",
        "  }, 20);",
        "}",
        "",
      ].join("\n"),
    );
    const { server, output } = await startInstalled(
      `--import ${pathToFileURL(busy).href}`,
    );
    const code = await terminate(server);
    expect(fs.existsSync(path.join(tmpBase, "busy.on"))).toBe(true);
    expect(output()).not.toMatch(/unhandled rejection/);
    // 143 is a SIGKILL'd or unhandled SIGTERM: the shutdown never ran.
    expect(code).toBe(0);
  }, 200_000);
});
