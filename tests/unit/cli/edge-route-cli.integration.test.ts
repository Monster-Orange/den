/**
 * Issue 455: `edge route --for nginx|caddy|traefik` prints a route ready to
 * paste. Doctor and the Edge page tell people to run it. On the bed (11-18,
 * v0.4.68-dev.2) the real CLI refused it before it ran: the edge command's
 * flag check knew only --take-over and --rotate-proof, so `--for` was an
 * "Unknown flag" and the exit was 1. The unit tests called the command's
 * function directly and never went through that check.
 *
 * Here the real bin/den runs in a throwaway distribution, with `docker` and
 * `lsof` shims on PATH that answer nothing. Nothing real runs.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const ENGINE = path.resolve(__dirname, "../../..");
let tmp = "";
let root = "";
let shim = "";

function write(file: string, content: string, mode?: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, mode ? { mode } : undefined);
}

function den(args: string[]): { code: number; out: string; err: string } {
  const r = spawnSync(path.join(ENGINE, "bin", "den"), args, {
    cwd: root,
    encoding: "utf-8",
    input: "",
    env: {
      HOME: path.join(tmp, "home"),
      PATH: `${shim}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      DEN_ROOT: root,
      DEN_HOME: path.join(tmp, "home", ".den"),
      DEN_DAEMONS_FILE: path.join(tmp, "daemons.json"),
      FORCE_COLOR: "0",
      NO_COLOR: "1",
    },
    timeout: 60_000,
  });
  return { code: r.status ?? -1, out: r.stdout, err: r.stderr };
}

beforeAll(() => {
  tmp = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "den-edge-route-")),
  );
  root = path.join(tmp, "den");
  shim = path.join(tmp, "shim");
  write(path.join(root, "den.yml"), "product:\n  name: den\n");
  write(
    path.join(root, "config", "den.yml"),
    [
      "environments: [local]",
      "edge:",
      "  org: acme",
      "  domain: acme.localhost",
      "  publish: false",
      "  tls: none",
      `  state_dir: ${path.join(tmp, "edge")}`,
      "",
    ].join("\n"),
  );
  for (const tool of ["docker", "lsof"])
    write(path.join(shim, tool), "#!/bin/sh\nexit 1\n", 0o755);
});

afterAll(() => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

describe("edge route --for <proxy> through the real CLI", () => {
  it.each([
    ["nginx", /server_name .+;[\s\S]*proxy_pass http:\/\//],
    ["caddy", /reverse_proxy /],
    ["traefik", /rule: "Host\(`/],
  ])("--for %s prints its route and exits 0", (kind, shape) => {
    const r = den(["edge", "route", "--for", kind]);
    expect(r.err).not.toMatch(/Unknown flag/);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(shape);
  });

  it("takes the --for=<proxy> form too", () => {
    const r = den(["edge", "route", "--for=caddy"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/reverse_proxy /);
  });

  it("still refuses a flag the edge command doesn't know", () => {
    const r = den(["edge", "route", "--fro", "nginx"]);
    expect(r.code).not.toBe(0);
    expect(`${r.out}${r.err}`).toMatch(/Unknown flag for 'edge': --fro/);
  });
});
