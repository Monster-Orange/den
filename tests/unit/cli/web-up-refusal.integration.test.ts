/**
 * `web up` and `web restart` when the server refuses to start (SEC-1 §4's
 * bind refusal; a wrong web.session value): the CLI prints the server's own
 * reason line, then where the log is, instead of only "did not become
 * ready". A throwaway distribution and state dir; the server exits at once
 * (nothing is left listening). No secret is involved or printed.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as net from "net";
import type { AddressInfo } from "net";
import * as os from "os";
import * as path from "path";

const ENGINE = path.resolve(__dirname, "../../..");
let tmp = "";
let root = "";
let port = 0;

beforeAll(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-wup-")));
  root = path.join(tmp, "dist");
  fs.mkdirSync(path.join(root, "config"), { recursive: true });
  fs.writeFileSync(path.join(root, "den.yml"), "product:\n  name: den\n");
  fs.writeFileSync(
    path.join(root, "config", "den.yml"),
    "environments: [local]\n",
  );
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, "localhost", r));
  port = (s.address() as AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
});
afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function cli(args: string[], env: Record<string, string> = {}) {
  const r = spawnSync(
    path.join(ENGINE, "node_modules", ".bin", "tsx"),
    [path.join(ENGINE, "src", "ui", "cli", "index.ts"), ...args],
    {
      cwd: root,
      encoding: "utf-8",
      timeout: 120_000,
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: path.join(tmp, "home"),
        TMPDIR: os.tmpdir(),
        DEN_ROOT: root,
        DEN_ENGINE_ROOT: ENGINE,
        DEN_HOME: path.join(tmp, "home", ".den"),
        DEN_EDGE_DIR: path.join(tmp, "edge-state"),
        DEN_NO_OPEN: "1",
        NO_COLOR: "1",
        CI: "1",
        ...env,
      },
    },
  );
  return { status: r.status, all: `${r.stdout}\n${r.stderr}` };
}

describe("the server's refusal reaches the person", () => {
  for (const action of ["up", "restart"]) {
    it(`web ${action} on a non-loopback bind without HTTPS in front prints why, then the log`, () => {
      const r = cli(["web", action, "--no-open", "--port", String(port)], {
        DEN_BIND_HOST: "0.0.0.0",
      });
      expect(r.status).not.toBe(0);
      expect(r.all).toMatch(
        /web refused to start: Refusing to listen on 0\.0\.0\.0: it is reachable beyond this machine/,
      );
      expect(r.all).toMatch(/See .*web\.log/);
      expect(r.all).not.toMatch(/did not become ready/);
    }, 150_000);
  }
});
