/**
 * Issue 786 part 3b on a real server: Settings › Navigation › Layout
 * snapshots. A person lists the snapshots and puts one back; an open page
 * whose copy of the layout is older than the stored one is refused (409
 * layout_changed, with the layout now) and never writes its copy over
 * the restore; a page that sends no revision (an older page) is taken as
 * before; and a request without a person's sign-in is refused. The
 * routes are in layout-routes.ts and index.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { type ChildProcess } from "child_process";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import { startDenServer, stopServer } from "../../child-servers.js";
import { signedIn, type SignedIn } from "./helpers/signed-in.js";

const ENGINE = path.resolve(__dirname, "../../..");
const TSX = path.join(ENGINE, "node_modules", ".bin", "tsx");
const AGENT_KEYS = [
  "DEN_AGENT",
  "DEN_ACTOR_TOKEN",
  "DEN_ACTOR_TOKEN_FILE",
  "DEN_PERSON_TOKEN",
];

let tmp = "";
let root = "";
let stateDir = "";
let base = "";
let server: ChildProcess;
let person: SignedIn;

function call(
  method: string,
  p: string,
  headers: Record<string, string> = {},
  body: unknown = {},
): Promise<{ status: number; json: Record<string, unknown> }> {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      `${base}${p}`,
      {
        method,
        agent: false,
        timeout: 30_000,
        headers: {
          connection: "close",
          ...(method === "POST"
            ? {
                "content-type": "application/json",
                "content-length": String(Buffer.byteLength(payload)),
              }
            : {}),
          ...headers,
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
    req.on("timeout", () => req.destroy(new Error(`timeout: ${p}`)));
    req.end(method === "POST" ? payload : undefined);
  });
}

beforeAll(async () => {
  tmp = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "den-786-layout-")),
  );
  root = path.join(tmp, "dist");
  const home = path.join(tmp, "home");
  stateDir = path.join(tmp, "state");
  fs.mkdirSync(path.join(root, "config"), { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(root, "den.yml"), "product:\n  name: den\n");
  fs.writeFileSync(
    path.join(root, "config", "den.yml"),
    "environments: [local]\n",
  );
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of [...AGENT_KEYS, "DEN_HOME", "DEN_TEST_INSTALL"])
    delete env[k];
  const s = await startDenServer(
    TSX,
    [path.join(ENGINE, "src", "ui", "server", "index.ts")],
    {
      cwd: root,
      env: {
        ...env,
        DEN_ROOT: root,
        DEN_ENGINE_ROOT: ENGINE,
        HOME: home,
        DEN_HOME: stateDir,
        DEN_NO_OPEN: "1",
        NO_COLOR: "1",
      },
    },
    { timeoutMs: 40_000 },
  );
  base = `http://localhost:${s.port}`;
  server = s.server;
  person = await signedIn(stateDir, base);
}, 90_000);

afterAll(async () => {
  if (server) await stopServer(server);
  fs.rmSync(tmp, { recursive: true, force: true });
});

const OLD = "2026-01-01T08-00-00-000Z";
const seed = () => {
  const dir = path.join(stateDir, "layout-snapshots");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${OLD}.json`),
    JSON.stringify({
      at: "2026-01-01T08:00:00.000Z",
      shell: { hidden: ["logs"], collapsed: false },
    }),
  );
};

describe("layout snapshots on a real server", () => {
  it("a request without a person's sign-in is refused", async () => {
    const r = await call(
      "POST",
      "/api/layout/restore",
      { origin: base },
      {
        id: OLD,
      },
    );
    expect([401, 403]).toContain(r.status);
  });

  it("a person lists the snapshots and puts one back", async () => {
    seed();
    const list = await call("GET", "/api/layout/snapshots", person.headers);
    expect(list.status).toBe(200);
    expect(list.json.snapshots).toEqual([
      expect.objectContaining({ id: OLD, hidden: 1, current: false }),
    ]);
    const r = await call("POST", "/api/layout/restore", person.headers, {
      id: OLD,
    });
    expect(r.status).toBe(200);
    const s = await call("GET", "/api/settings", person.headers);
    expect((s.json.shell as { hidden: string[] }).hidden).toEqual(["logs"]);
    expect(s.json.shell_rev).toBe(r.json.shell_rev);
    const unknown = await call("POST", "/api/layout/restore", person.headers, {
      id: "2020-01-01T00-00-00-000Z",
    });
    expect(unknown.status).toBe(404);
  });

  it("a page with an older copy can't write it over a restore", async () => {
    const before = await call("GET", "/api/settings", person.headers);
    const staleRev = before.json.shell_rev as string;
    // Another window changes the layout (the revision moves on).
    const other = await call(
      "POST",
      "/api/settings",
      { ...person.headers, "x-den-layout-rev": staleRev },
      { shell: { hidden: ["tests"] } },
    );
    expect(other.status).toBe(200);
    expect(other.json.shell_rev).not.toBe(staleRev);
    // This page still has the revision it loaded.
    const r = await call(
      "POST",
      "/api/settings",
      { ...person.headers, "x-den-layout-rev": staleRev },
      { shell: { collapsed: true } },
    );
    expect(r.status).toBe(409);
    expect(r.json).toMatchObject({ ok: false, error: "layout_changed" });
    expect((r.json.shell as { hidden: string[] }).hidden).toEqual(["tests"]);
    const s = await call("GET", "/api/settings", person.headers);
    expect((s.json.shell as { collapsed: boolean }).collapsed).toBe(false);
  });

  it("a save with no revision (an older page) is taken as before", async () => {
    const r = await call("POST", "/api/settings", person.headers, {
      shell: { collapsed: true },
    });
    expect(r.status).toBe(200);
    const s = await call("GET", "/api/settings", person.headers);
    expect((s.json.shell as { collapsed: boolean }).collapsed).toBe(true);
  });
});
