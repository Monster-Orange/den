/**
 * Issue 601 clause 2, on a real server, with an address only this machine
 * opens (an https edge name under `.localhost`, as an install made before
 * issue 666 kept it, with no alias to take in its place).
 *
 * Once that address is proven, a browser on this machine that opens the
 * loopback sign-in page is sent there: a 303 to the same path, no cookie.
 * Never a bare 401 page. Issue 666 stays true: the address is never sent
 * to a device that isn't this machine, and a request on the address
 * itself is answered there (no loop).
 *
 * Subject (issue 708): src/ui/server/named-address.ts, src/ui/server/index.ts.
 *
 * The edge is modelled with its headers (helpers/edge-proof.ts): the
 * edge's proven https request for the address is what proves it. No code,
 * cookie or token is printed.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import type { ChildProcess } from "child_process";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import { readWebSecret } from "../../../src/shared/web-secret.js";
import { mintLoginCode } from "../../../src/shared/web-session.js";
import { startDenServer, stopServer } from "../../child-servers.js";
import { EDGE_PROOF, writeTestEdgeProof } from "./helpers/edge-proof.js";

const ENGINE = path.resolve(__dirname, "../../..");
const TSX = path.join(ENGINE, "node_modules", ".bin", "tsx");
/** An address only this machine opens. */
const LOOP_NAMED = "den.acme.localhost";
const EDGE = {
  ...EDGE_PROOF,
  "x-forwarded-for": "127.0.0.1",
  "x-forwarded-proto": "https",
};
let tmp = "";
let stateDir = "";
let port = 0;
let server: ChildProcess;

interface Reply {
  status: number;
  body: string;
  headers: http.IncomingHttpHeaders;
}
function call(p: string, headers: Record<string, string>): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const r = http.request(
      {
        host: "127.0.0.1",
        port,
        path: p,
        method: "GET",
        agent: false,
        timeout: 20_000,
        setHost: false,
        headers,
      },
      (res) => {
        let out = "";
        res.on("data", (d: Buffer) => (out += d.toString()));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body: out,
            headers: res.headers,
          }),
        );
      },
    );
    r.on("error", reject);
    r.on("timeout", () => r.destroy(new Error(`timeout: ${p}`)));
    r.end();
  });
}
const nav = { "sec-fetch-site": "none", accept: "text/html" };
const onAddress = () => ({ host: LOOP_NAMED, ...EDGE });
const sessionLine = (r: Reply) =>
  ([] as string[])
    .concat(r.headers["set-cookie"] ?? [])
    .find((c) => /den_session/i.test(c)) ?? "";

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

beforeAll(async () => {
  tmp = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "den-601-loop-address-")),
  );
  const root = path.join(tmp, "dist");
  const home = path.join(tmp, "home");
  stateDir = path.join(home, ".den");
  write(path.join(root, "den.yml"), "product:\n  name: den\n");
  write(
    path.join(root, "config", "den.yml"),
    [
      "environments: [local]",
      "edge:",
      "  org: acme",
      "  domain: acme.localhost",
      "  tls: none",
      "",
    ].join("\n"),
  );
  write(
    path.join(root, "config", "local", "user.yml"),
    [
      "web:",
      `  url: https://${LOOP_NAMED}`,
      "  address_check_cache_seconds: 3600",
      "  address_check_timeout_seconds: 1",
      "  address_check_retries: 0",
      "",
    ].join("\n"),
  );
  writeTestEdgeProof(path.join(tmp, "edge-state"));
  const started = await startDenServer(
    TSX,
    [path.join(ENGINE, "src", "ui", "server", "index.ts")],
    {
      cwd: root,
      env: {
        ...process.env,
        DEN_ROOT: root,
        DEN_ENGINE_ROOT: ENGINE,
        DEN_EDGE_DIR: path.join(tmp, "edge-state"),
        DEN_HOME: stateDir,
        HOME: home,
        DEN_NO_OPEN: "1",
        NO_COLOR: "1",
        PORT: "0",
      },
    },
    { timeoutMs: 40_000 },
  );
  server = started.server;
  port = started.port;
}, 60_000);

afterAll(async () => {
  await stopServer(server);
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("issue 601 clause 2 with an address only this machine opens", () => {
  it("the address is proven: a sign-in on it holds a __Host- cookie", async () => {
    const c = mintLoginCode(readWebSecret(stateDir)!);
    const r = await call(`/auth?c=${encodeURIComponent(c)}`, {
      ...onAddress(),
      ...nav,
    });
    expect(r.status).toBe(303);
    expect(sessionLine(r).startsWith(`__Host-den_session_${port}=`)).toBe(true);
  });

  it("a loopback /signin sends the browser to the address (303) and sets no cookie", async () => {
    const r = await call("/signin", { host: `127.0.0.1:${port}`, ...nav });
    expect({
      status: r.status,
      location: String(r.headers.location ?? ""),
      cookie: sessionLine(r),
    }).toEqual({
      status: 303,
      location: `https://${LOOP_NAMED}/signin`,
      cookie: "",
    });
  });

  it("on localhost too, with its query", async () => {
    const r = await call("/signin?next=%2Fsettings", {
      host: `localhost:${port}`,
      ...nav,
    });
    expect([r.status, String(r.headers.location ?? "")]).toEqual([
      303,
      `https://${LOOP_NAMED}/signin?next=%2Fsettings`,
    ]);
  });

  it("issue 666: a request through the edge (not this machine's loopback) is never sent there", async () => {
    const r = await call("/signin", {
      host: LOOP_NAMED,
      ...EDGE_PROOF,
      "x-forwarded-for": "192.0.2.7",
      "x-forwarded-proto": "http",
      ...nav,
    });
    expect([r.status, String(r.headers.location ?? "")]).toEqual([401, ""]);
  });

  it("on the address itself, /signin is answered there (no loop)", async () => {
    const r = await call("/signin", { ...onAddress(), ...nav });
    expect(r.status).not.toBe(303);
    expect(String(r.headers.location ?? "")).toBe("");
  });
});
