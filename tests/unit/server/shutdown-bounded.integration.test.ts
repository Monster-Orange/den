/**
 * The web server always exits, within a bound (shutdown-guard.ts).
 *
 * 1. Its output's reader goes away (the test runner, terminal or script that
 *    started it was killed). The next log line failed with EPIPE, the
 *    "continue" uncaughtException guard logged that to the dead stderr,
 *    which failed again: a loop at ~100% CPU that stopped the server
 *    answering, for as long as the orphan lived (40 h, seen in the wild).
 *    Now it writes nothing more and shuts down.
 * 2. A shutdown that stalls (a preload makes its process.exit return
 *    without exiting, once: a shutdown step that never finishes) is forced
 *    out by the deadline, and a second SIGTERM exits at once; the second was
 *    ignored.
 *
 * A throwaway distribution; the server is started the way `web up` starts
 * it (resolveServerEntrypoint) in a recorded process group
 * (tests/child-servers.ts).
 */
import { afterAll, describe, expect, it } from "@jest/globals";
import type { ChildProcess } from "child_process";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import { pathToFileURL } from "url";
import { resolveServerEntrypoint } from "../../../src/ui/cli/web-command.js";
import { startDenServer, stopServer } from "../../child-servers.js";

const ENGINE = path.resolve(__dirname, "../../..");
const tmpBase = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), "den-bounded-")),
);
const started: ChildProcess[] = [];

afterAll(async () => {
  await Promise.all(started.map((s) => stopServer(s, 1_000)));
  fs.rmSync(tmpBase, { recursive: true, force: true });
});

function get(port: number, p: string, timeout = 5_000): Promise<number> {
  return new Promise((resolve) => {
    const req = http.get(
      { host: "localhost", port, path: p, timeout, agent: false },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      },
    );
    req.on("error", () => resolve(0));
    req.on("timeout", () => req.destroy());
  });
}

async function start(
  env: Record<string, string> = {},
): Promise<{ server: ChildProcess; port: number }> {
  const tmp = fs.mkdtempSync(path.join(tmpBase, "case-"));
  const root = path.join(tmp, "dist");
  fs.mkdirSync(path.join(root, "config"), { recursive: true });
  fs.writeFileSync(path.join(root, "den.yml"), "product:\n  name: den\n");
  fs.writeFileSync(
    path.join(root, "config", "den.yml"),
    "environments: [local]\n",
  );
  const entry = resolveServerEntrypoint(ENGINE);
  const { server, port } = await startDenServer(
    entry.cmd,
    entry.args,
    {
      cwd: root,
      env: {
        ...process.env,
        DEN_ROOT: root,
        DEN_HOME: path.join(tmp, "home"),
        DEN_NO_OPEN: "1",
        ...env,
      },
    },
    { timeoutMs: 60_000 },
  );
  started.push(server);
  return { server, port };
}

/** Resolves with "exited" once `server` exits, or "running" after `ms`. */
function exitWithin(server: ChildProcess, ms: number): Promise<string> {
  if (server.exitCode !== null || server.signalCode !== null)
    return Promise.resolve("exited");
  return Promise.race([
    new Promise<string>((r) => server.once("exit", () => r("exited"))),
    new Promise<string>((r) => setTimeout(() => r("running"), ms).unref()),
  ]);
}

describe("the server's exit is bounded", () => {
  it("its output's reader gone, the next log line ends it: no EPIPE loop, no orphan", async () => {
    const { server, port } = await start();
    // The reader goes away, as when the runner that started it is killed.
    server.stdout!.destroy();
    server.stderr!.destroy();
    await new Promise((r) => setTimeout(r, 200));
    // Any request is logged: the write that hits the closed pipe.
    await get(port, "/api/server-info", 2_000);
    expect(await exitWithin(server, 10_000)).toBe("exited");
  }, 90_000);

  describe("a shutdown that stalls", () => {
    // The shutdown's own process.exit(0) returns without exiting (a
    // shutdown step that never finishes); an exit with another code (the
    // deadline's, a second signal's) still exits.
    const stall = path.join(tmpBase, "stall-exit.mjs");
    fs.writeFileSync(
      stall,
      [
        'if (/server[\\/]index\\.ts$/.test(process.argv[1] ?? "")) {',
        "  const exit = process.exit.bind(process);",
        "  process.exit = (code) => (code ? exit(code) : undefined);",
        "}",
        "",
      ].join("\n"),
    );
    const preload = { NODE_OPTIONS: `--import ${pathToFileURL(stall).href}` };

    it("is forced out by the deadline after a SIGTERM", async () => {
      const { server } = await start({
        ...preload,
        DEN_SHUTDOWN_DEADLINE_MS: "1000",
      });
      server.kill("SIGTERM");
      expect(await exitWithin(server, 8_000)).toBe("exited");
    }, 90_000);

    it("a second SIGTERM exits at once", async () => {
      const { server } = await start({
        ...preload,
        DEN_SHUTDOWN_DEADLINE_MS: "600000",
      });
      server.kill("SIGTERM");
      await new Promise((r) => setTimeout(r, 500));
      server.kill("SIGTERM");
      expect(await exitWithin(server, 4_000)).toBe("exited");
    }, 90_000);
  });
});
