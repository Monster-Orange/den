/**
 * `<cli> <command> <sub> --help` prints that subcommand's own help: the
 * dispatcher's general `<command> --help` (and cmdWeb's) used to answer
 * first, so `web sessions --help` printed the general web help.
 *
 * Real bin/den in a throwaway distribution. Nothing is started: each help
 * returns before any call to a server (PORT is a closed port regardless).
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

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function den(args: string[]): { code: number; out: string } {
  const r = spawnSync(path.join(ENGINE, "bin", "den"), args, {
    cwd: root,
    encoding: "utf-8",
    input: "",
    env: {
      ...process.env,
      DEN_ROOT: root,
      DEN_HOME: path.join(tmp, "home"),
      DEN_DAEMONS_FILE: path.join(tmp, "daemons.json"),
      PORT: String(port),
      FORCE_COLOR: "0",
      NO_COLOR: "1",
    },
    timeout: 60_000,
  });
  return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
}

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "den-subhelp-"));
  root = path.join(tmp, "den");
  write(path.join(root, "den.yml"), "product:\n  name: den\n");
  write(path.join(root, "config", "den.yml"), "environments: [local]\n");
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, "localhost", r));
  port = (s.address() as AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** The general web help's own section heading. */
const GENERAL = /^Actions:$/m;

describe("web <sub> --help", () => {
  it.each([
    ["sessions", /Usage: den web sessions \[--json\]/, /LAST SEEN/],
    [
      "login",
      /Usage: den web login \[--next <path>\]/,
      /one-time sign-in link/,
    ],
    [
      "logout",
      /Usage: den web logout \[<id prefix>\]/,
      /--all\s+sign out every/,
    ],
    ["token", /Usage: den web token --print/, /authorizes your CLI's calls/],
  ])(
    "web %s --help: its own help, not the general web help",
    (sub, usage, line) => {
      for (const flag of ["--help", "-h"]) {
        const r = den(["web", sub, flag]);
        expect([sub, flag, r.code]).toEqual([sub, flag, 0]);
        expect(r.out).toMatch(usage);
        expect(r.out).toMatch(line);
        expect(r.out).not.toMatch(GENERAL);
      }
    },
    120_000,
  );
});

describe("mcp <sub> --help", () => {
  it("mcp connect --help prints the setup subcommands' usage, not `mcp`'s; web --help and web up --help stay general", () => {
    for (const args of [
      ["web", "--help"],
      ["web", "up", "--help"],
    ]) {
      const g = den(args);
      expect(g.code).toBe(0);
      expect(g.out).toMatch(GENERAL);
    }
    const r = den(["mcp", "connect", "--help"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/den mcp connect \[<client>\.\.\.\|--all\]/);
    expect(r.out).toMatch(/Clients: /);
  }, 90_000);
});
