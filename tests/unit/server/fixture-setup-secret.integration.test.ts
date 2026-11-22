/**
 * Issue 1018 on real servers: a test install's fixture person made from
 * the launcher's one-time setup value, with no browser session.
 *  - real: the mark, its own state folder, the setup value, but no launch
 *    flag. Refused, and no key is written.
 *  - once: a test install (not new, so it got no key at creation). The
 *    first try makes the key and `web fixture-login` works; a second try,
 *    with the right value, is refused.
 *  - wrong: a test install. A wrong value is refused and spends the value:
 *    the right one is then refused too, and no key is written.
 * An agent's claim is refused before the value is read. No answer, log
 * line or audit line holds the value.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { spawnSync, type ChildProcess } from "child_process";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import { startDenServer, stopServer } from "../../child-servers.js";
import { fixturePersonPath } from "../../../src/shared/fixture-person.js";
import { readFixtureMadeBy } from "../../../src/shared/fixture-setup-secret.js";
import { personToken, readWebSecret } from "../../../src/shared/web-secret.js";

const ENGINE = path.resolve(__dirname, "../../..");
const TSX = path.join(ENGINE, "node_modules", ".bin", "tsx");
const AGENT_KEYS = [
  "DEN_AGENT",
  "DEN_ACTOR_TOKEN",
  "DEN_ACTOR_TOKEN_FILE",
  "DEN_PERSON_TOKEN",
];
const VALUE = "setup-value-1018-aaaaaaaaaaaaaaaaaaaaaaaa";

interface Den {
  root: string;
  home: string;
  stateDir: string;
  port: number;
  server: ChildProcess;
  out: () => string;
}
let tmp = "";
let real: Den;
let once: Den;
let wrong: Den;

function baseEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const k of [
    ...AGENT_KEYS,
    "DEN_HOME",
    "DEN_TEST_INSTALL",
    "DEN_FIXTURE_SETUP_SECRET",
  ])
    delete env[k];
  return env;
}

const MARKED = ["environments: [local]", "web:", "  test_install: true", ""];

async function startDen(name: string, o: { flag: boolean }): Promise<Den> {
  const root = path.join(tmp, name, "dist");
  const home = path.join(tmp, name, "home");
  const stateDir = path.join(tmp, name, "state");
  fs.mkdirSync(path.join(root, "config"), { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  // Not a new install: the state folder isn't empty, so it gets no
  // fixture person at creation (issue 814) and needs one made.
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, "earlier.txt"), "an earlier start\n");
  fs.writeFileSync(path.join(root, "den.yml"), "product:\n  name: den\n");
  fs.writeFileSync(path.join(root, "config", "den.yml"), MARKED.join("\n"));
  const s = await startDenServer(
    TSX,
    [path.join(ENGINE, "src", "ui", "server", "index.ts")],
    {
      cwd: root,
      env: {
        ...baseEnv(),
        DEN_ROOT: root,
        DEN_ENGINE_ROOT: ENGINE,
        HOME: home,
        DEN_HOME: stateDir,
        DEN_NO_OPEN: "1",
        NO_COLOR: "1",
        DEN_FIXTURE_SETUP_SECRET: VALUE,
        ...(o.flag ? { DEN_TEST_INSTALL: "1" } : {}),
      },
    },
    { timeoutMs: 40_000 },
  );
  return { root, home, stateDir, port: s.port, server: s.server, out: s.out };
}

/** `<cli> web <sub> …` against `den`, with the setup value as given. */
function cli(den: Den, args: string[], value: string | null) {
  return spawnSync(
    TSX,
    [
      path.join(ENGINE, "src", "ui", "cli", "index.ts"),
      "web",
      ...args,
      ...(args[0] === "fixture-person" ? ["--port", String(den.port)] : []),
    ],
    {
      cwd: den.root,
      encoding: "utf-8",
      timeout: 60_000,
      env: {
        ...baseEnv(),
        DEN_ROOT: den.root,
        DEN_ENGINE_ROOT: ENGINE,
        DEN_HOME: den.stateDir,
        HOME: den.home,
        NO_COLOR: "1",
        CI: "1",
        ...(value === null ? {} : { DEN_FIXTURE_SETUP_SECRET: value }),
      },
    },
  );
}
const fromSecret = (den: Den, value: string | null) =>
  cli(den, ["fixture-person", "--from-setup-secret"], value);

/** POST the route straight, with the person's CLI token and `extra` headers. */
function post(
  den: Den,
  body: unknown,
  extra: Record<string, string> = {},
): Promise<{ status: number; json: Record<string, unknown> }> {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "localhost",
        port: den.port,
        path: "/api/web/fixture-person/setup-secret",
        method: "POST",
        agent: false,
        timeout: 20_000,
        headers: {
          connection: "close",
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(payload)),
          authorization: `Bearer ${personToken(readWebSecret(den.stateDir)!)}`,
          ...extra,
        },
      },
      (res) => {
        let buf = "";
        res.on("data", (d: Buffer) => (buf += d.toString()));
        res.on("end", () => {
          let json: Record<string, unknown> = {};
          try {
            json = JSON.parse(buf) as Record<string, unknown>;
          } catch {
            /* not json */
          }
          resolve({ status: res.statusCode ?? 0, json });
        });
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
}

const audit = (den: Den) => {
  try {
    return fs.readFileSync(path.join(den.stateDir, "audit.jsonl"), "utf-8");
  } catch {
    return "";
  }
};
const hasKey = (den: Den) => fs.existsSync(fixturePersonPath(den.stateDir));
const leaks = (den: Den, ...more: string[]) =>
  [den.out(), audit(den), ...more].some((t) => t.includes(VALUE));

beforeAll(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-fx1018-")));
  [real, once, wrong] = await Promise.all([
    startDen("real", { flag: false }),
    startDen("once", { flag: true }),
    startDen("wrong", { flag: true }),
  ]);
}, 120_000);
afterAll(async () => {
  await Promise.all(
    [real, once, wrong].filter(Boolean).map((d) => stopServer(d.server)),
  );
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("a real install", () => {
  it("refuses, even with the setup value set, and writes no key", () => {
    const r = fromSecret(real, VALUE);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/isn't a test install/);
    expect(hasKey(real)).toBe(false);
    expect(leaks(real, r.stdout, r.stderr)).toBe(false);
  });
});

describe("a test install", () => {
  it("has no fixture person to begin with", () => {
    expect(hasKey(once)).toBe(false);
    expect(hasKey(wrong)).toBe(false);
  });

  it("refuses an agent's claim before it reads the value, which stays unspent", async () => {
    const r = await post(
      once,
      { secret: VALUE },
      { "x-den-actor": "agent", "x-den-actor-client": "claude-code" },
    );
    expect([r.status, r.json.code]).toEqual([403, "person_only"]);
    expect(hasKey(once)).toBe(false);
  });

  it("refuses the CLI with no setup value of its own, and the value stays unspent", () => {
    const r = fromSecret(once, null);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/DEN_FIXTURE_SETUP_SECRET/);
    expect(hasKey(once)).toBe(false);
  });

  it("accepts it once: the key is written, audited, and fixture-login works", () => {
    const r = fromSecret(once, VALUE);
    expect([r.status, r.stderr]).toEqual([0, ""]);
    expect(hasKey(once)).toBe(true);
    const line = audit(once)
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .find((e) =>
        String(e.detail).includes("fixture person made from the setup secret"),
      );
    expect(line?.principal).toBe("fixture:person");
    const login = cli(
      once,
      ["fixture-login", "--origin", `http://localhost:${once.port}`],
      null,
    );
    expect([login.status, login.stderr]).toEqual([0, ""]);
    expect(login.stdout).toMatch(/\/auth\?fixture=/);
    expect(leaks(once, r.stdout, r.stderr)).toBe(false);
  });

  it("records how the key was made, for doctor's Sign-in row", () => {
    expect(readFixtureMadeBy(once.stateDir)).toBe("setup-secret");
  });

  it("refuses a second try, even with the right value", () => {
    const before = fs.readFileSync(fixturePersonPath(once.stateDir), "utf-8");
    const r = fromSecret(once, VALUE);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/already used/);
    expect(fs.readFileSync(fixturePersonPath(once.stateDir), "utf-8")).toBe(
      before,
    );
  });

  it("refuses a wrong value, spends it, and writes no key", () => {
    const r = fromSecret(wrong, "not-the-value");
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/doesn't match/);
    expect(hasKey(wrong)).toBe(false);
    const again = fromSecret(wrong, VALUE);
    expect(again.status).toBe(1);
    expect(again.stderr).toMatch(/already used/);
    expect(hasKey(wrong)).toBe(false);
    expect(leaks(wrong, r.stderr, again.stderr)).toBe(false);
  });
});
