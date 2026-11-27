/**
 * Issue 1344 on a real server, started the way `web up` and a service
 * start it: its stdout and stderr are web.log, and --silent (web up's
 * default). The fixture person's sign-in on a test install writes its
 * lifecycle line, "fixture person signed in (live checks, a test
 * install)", to web.log: once, with --silent or without.
 * No code, cookie or secret is printed: failures show statuses and text.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import { startDenServer, stopServer } from "../../child-servers.js";
import {
  mintFixtureCode,
  readFixtureKey,
} from "../../../src/shared/fixture-person.js";
import type { ChildProcess } from "child_process";

const ENGINE = path.resolve(__dirname, "../../..");
const TSX = path.join(ENGINE, "node_modules", ".bin", "tsx");
const AGENT_KEYS = [
  "DEN_AGENT",
  "DEN_ACTOR_TOKEN",
  "DEN_ACTOR_TOKEN_FILE",
  "DEN_HOME",
  "DEN_TEST_INSTALL",
];
const LINE = "fixture person signed in (live checks, a test install)";

interface Den {
  stateDir: string;
  base: string;
  server: ChildProcess;
  log: string;
}

let tmp = "";
const dens: Den[] = [];

async function startLikeWebUp(name: string, silent: boolean): Promise<Den> {
  const root = path.join(tmp, name, "dist");
  const home = path.join(tmp, name, "home");
  const stateDir = path.join(tmp, name, "state");
  fs.mkdirSync(path.join(root, "config"), { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(root, "den.yml"), "product:\n  name: den\n");
  fs.writeFileSync(
    path.join(root, "config", "den.yml"),
    ["environments: [local]", "web:", "  test_install: true", ""].join("\n"),
  );
  // As web up and a service: web.log opened for appending, as the
  // server's stdout and stderr. Outside the state folder (a service's
  // logs folder), so the folder is new and the install is a test install.
  const log = path.join(tmp, name, "logs", "web.log");
  fs.mkdirSync(path.dirname(log), { recursive: true });
  const fd = fs.openSync(log, "a");
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of AGENT_KEYS) delete env[k];
  try {
    const s = await startDenServer(
      TSX,
      [
        path.join(ENGINE, "src", "ui", "server", "index.ts"),
        ...(silent ? ["--silent"] : []),
      ],
      {
        cwd: root,
        stdio: ["ignore", fd, fd],
        env: {
          ...env,
          DEN_ROOT: root,
          DEN_ENGINE_ROOT: ENGINE,
          HOME: home,
          DEN_HOME: stateDir,
          DEN_TEST_INSTALL: "1",
          DEN_NO_OPEN: "1",
          NO_COLOR: "1",
        },
      },
      { timeoutMs: 40_000, logFile: log },
    );
    return {
      stateDir,
      base: `http://localhost:${s.port}`,
      server: s.server,
      log,
    };
  } finally {
    fs.closeSync(fd);
  }
}

/** The fixture person's sign-in link, followed: its status. */
function fixtureSignIn(den: Den): Promise<number> {
  const code = mintFixtureCode(readFixtureKey(den.stateDir)!);
  const u = new URL(`/auth?fixture=${encodeURIComponent(code)}`, den.base);
  return new Promise((resolve, reject) => {
    const req = http.get(
      u,
      { headers: { "sec-fetch-site": "none", accept: "text/html" } },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      },
    );
    req.on("error", reject);
  });
}

const count = (text: string, s: string) => text.split(s).length - 1;

beforeAll(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-1344-")));
  dens.push(
    ...(await Promise.all([
      startLikeWebUp("silent", true),
      startLikeWebUp("loud", false),
    ])),
  );
}, 120_000);
afterAll(async () => {
  await Promise.all(dens.map((d) => stopServer(d.server)));
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("issue 1344: web.log has the fixture sign-in line", () => {
  it.each([
    ["with --silent (web up's default)", 0],
    ["without --silent", 1],
  ])("%s: once", async (_how, i) => {
    const den = dens[i]!;
    expect(await fixtureSignIn(den)).toBe(303);
    const text = fs.readFileSync(den.log, "utf-8");
    expect(count(text, LINE)).toBe(1);
  });
});
