/**
 * Issue 1073 on real servers. Both installs are started with
 * DEN_TEST_RESOLVE mapping the edge name `den.bed.test` (which no DNS
 * resolves) to 127.0.0.1:
 *  - test: a test install (the mark, the launch flag, its own state
 *    folder). Den's address check resolves the name through the map, so
 *    Check and save proves and saves `http://den.bed.test:<port>`.
 *  - real: the mark and its own state folder, no launch flag. The map is
 *    ignored: the name doesn't resolve, nothing is saved, and the server
 *    says the map was ignored.
 * A `test_resolve` key in the config is never read.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { type ChildProcess } from "child_process";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import { startDenServer, stopServer } from "../../child-servers.js";
import { personToken, readWebSecret } from "../../../src/shared/web-secret.js";

const ENGINE = path.resolve(__dirname, "../../..");
const TSX = path.join(ENGINE, "node_modules", ".bin", "tsx");
const AGENT_KEYS = [
  "DEN_AGENT",
  "DEN_ACTOR_TOKEN",
  "DEN_ACTOR_TOKEN_FILE",
  "DEN_PERSON_TOKEN",
];
const NAME = "den.bed.test";

interface Den {
  stateDir: string;
  port: number;
  server: ChildProcess;
  out: () => string;
}
let tmp = "";
let test: Den;
let real: Den;

function baseEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const k of [
    ...AGENT_KEYS,
    "DEN_HOME",
    "DEN_TEST_INSTALL",
    "DEN_TEST_RESOLVE",
  ])
    delete env[k];
  return env;
}

async function startDen(
  name: string,
  o: { flag: boolean; configMap?: boolean },
): Promise<Den> {
  const root = path.join(tmp, name, "dist");
  const home = path.join(tmp, name, "home");
  const stateDir = path.join(tmp, name, "state");
  fs.mkdirSync(path.join(root, "config"), { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(root, "den.yml"), "product:\n  name: den\n");
  fs.writeFileSync(
    path.join(root, "config", "den.yml"),
    [
      "environments: [local]",
      "web:",
      "  test_install: true",
      // Never read: the map comes from the start environment only.
      ...(o.configMap ? [`  test_resolve: "${NAME}=127.0.0.1"`] : []),
      "edge:",
      "  org: bed",
      "  domain: bed.test",
      "  tls: none",
      "",
    ].join("\n"),
  );
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
        ...(o.configMap ? {} : { DEN_TEST_RESOLVE: `${NAME}=127.0.0.1` }),
        ...(o.flag ? { DEN_TEST_INSTALL: "1" } : {}),
      },
    },
    { timeoutMs: 40_000 },
  );
  return { stateDir, port: s.port, server: s.server, out: s.out };
}

/** Check and save, as the person's CLI bearer on this machine. */
function save(
  den: Den,
  url: string,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const payload = JSON.stringify({ url });
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "localhost",
        port: den.port,
        path: "/api/web-url",
        method: "POST",
        agent: false,
        timeout: 30_000,
        headers: {
          connection: "close",
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(payload)),
          authorization: `Bearer ${personToken(readWebSecret(den.stateDir)!)}`,
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

beforeAll(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-tr1073-")));
  [test, real] = await Promise.all([
    startDen("test", { flag: true }),
    startDen("real", { flag: false }),
  ]);
}, 120_000);
afterAll(async () => {
  await Promise.all(
    [test, real].filter(Boolean).map((d) => stopServer(d.server)),
  );
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("issue 1073: the test install's name map for Den's address check", () => {
  it("on a test install, the mapped name resolves: Check and save proves and saves it", async () => {
    const url = `http://${NAME}:${test.port}`;
    const r = await save(test, url);
    expect([r.status, r.json.ok, r.json.url]).toEqual([200, true, url]);
  });

  it("on an install that isn't a test install, the map is ignored: the name doesn't resolve", async () => {
    const r = await save(real, `http://${NAME}:${real.port}`);
    expect(r.status).toBe(422);
    expect(String(r.json.error)).toMatch(/doesn't resolve on this machine/);
  });

  it("the server says it ignored the map, naming the setting", () => {
    expect(real.out()).toMatch(/DEN_TEST_RESOLVE is ignored/);
    expect(test.out()).not.toMatch(/DEN_TEST_RESOLVE is ignored/);
  });

  it("doctor's state: ignored on the real install, used on the test install", () => {
    const read = (d: Den) =>
      JSON.parse(
        fs.readFileSync(path.join(d.stateDir, "test-resolve.json"), "utf8"),
      ) as { state: string };
    expect(read(real).state).toBe("ignored");
    expect(read(test).state).toBe("used");
  });
});

describe("issue 1073: never from a config file", () => {
  let cfgOnly: Den;
  beforeAll(async () => {
    cfgOnly = await startDen("cfg", { flag: true, configMap: true });
  }, 60_000);
  afterAll(async () => {
    if (cfgOnly) await stopServer(cfgOnly.server);
  });

  it("a test install with the map only in its config: the name doesn't resolve", async () => {
    const r = await save(cfgOnly, `http://${NAME}:${cfgOnly.port}`);
    expect(r.status).toBe(422);
    expect(String(r.json.error)).toMatch(/doesn't resolve on this machine/);
  });
});
