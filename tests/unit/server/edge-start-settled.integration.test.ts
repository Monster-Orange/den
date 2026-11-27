import { afterEach, describe, expect, it } from "@jest/globals";
import type { ChildProcess } from "child_process";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import { freePort, startDenServer, stopServer } from "../../child-servers.js";
import { EDGE_PROOF, writeTestEdgeProof } from "./helpers/edge-proof.js";

const ENGINE = path.resolve(__dirname, "../../..");
const TSX = path.join(ENGINE, "node_modules", ".bin", "tsx");

interface Reply {
  status: number;
  body: string;
  type: string;
  retryAfter: string | undefined;
}

function get(
  port: number,
  headers: Record<string, string>,
  p = "/api/server-info",
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "localhost",
        port,
        path: p,
        agent: false,
        timeout: 15_000,
        setHost: false,
        headers: { host: `localhost:${port}`, ...headers },
      },
      (res) => {
        let out = "";
        res.on("data", (d: Buffer) => (out += d.toString()));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body: out,
            type: String(res.headers["content-type"] ?? ""),
            retryAfter: res.headers["retry-after"] as string | undefined,
          }),
        );
      },
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.end();
  });
}

const settled = async (port: number): Promise<unknown> =>
  (JSON.parse((await get(port, {})).body) as { edgeSettled?: unknown })
    .edgeSettled;

const fromTheEdge = {
  host: "den.acme.localhost",
  "x-forwarded-for": "127.0.0.1",
  ...EDGE_PROOF,
};
const wrongProof = {
  ...fromTheEdge,
  "x-den-edge-proof": "00".repeat(32),
};
const withoutId = (body: string) => {
  const j = JSON.parse(body) as Record<string, unknown>;
  delete j.requestId;
  return j;
};

async function until(
  done: () => boolean | Promise<boolean>,
  ms = 20_000,
): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await done())) {
    if (Date.now() > deadline) throw new Error("never happened");
    await new Promise((r) => setTimeout(r, 50));
  }
}

function heldEdgeStart() {
  const tmp = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "den-edge-settle-")),
  );
  const root = path.join(tmp, "dist");
  const bin = path.join(tmp, "bin");
  const asked = path.join(tmp, "docker-asked");
  const release = path.join(tmp, "docker-release");
  fs.mkdirSync(path.join(root, "config"), { recursive: true });
  fs.writeFileSync(path.join(root, "den.yml"), "product:\n  name: den\n");
  fs.writeFileSync(
    path.join(root, "config", "den.yml"),
    "environments: [local]\nedge:\n  org: acme\n  domain: acme.localhost\n  tls: none\n",
  );
  writeTestEdgeProof(path.join(tmp, "edge-state"));
  fs.mkdirSync(bin);
  fs.writeFileSync(
    path.join(bin, "docker"),
    [
      "#!/bin/sh",
      `: > "${asked}"`,
      `while [ ! -f "${release}" ]; do sleep 0.05; done`,
      'echo "Error: No such object: $*" >&2',
      "exit 1",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  const start = (wait: boolean, port?: number) =>
    startDenServer(
      TSX,
      [path.join(ENGINE, "src", "ui", "server", "index.ts")],
      {
        cwd: root,
        env: {
          ...process.env,
          PATH: [bin, process.env.PATH ?? ""].join(path.delimiter),
          DEN_ROOT: root,
          DEN_ENGINE_ROOT: ENGINE,
          DEN_EDGE_DIR: path.join(tmp, "edge-state"),
          DEN_HOME: path.join(tmp, "home", ".den"),
          HOME: path.join(tmp, "home"),
          DEN_NO_OPEN: "1",
          NO_COLOR: "1",
        },
      },
      {
        timeoutMs: 30_000,
        edgeSettled: wait,
        ...(port ? { pickPort: () => Promise.resolve(port) } : {}),
      },
    );
  return {
    tmp,
    start,
    asked: () => fs.existsSync(asked),
    release: () => fs.writeFileSync(release, ""),
  };
}

describe("the edge start settling", () => {
  let server: ChildProcess | undefined;
  let tmp = "";

  afterEach(async () => {
    if (server) await stopServer(server);
    server = undefined;
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("server-info says the start hasn't settled while the edge check runs, and the edge isn't trusted until it has", async () => {
    const h = heldEdgeStart();
    tmp = h.tmp;
    const s = await h.start(false);
    server = s.server;
    await until(h.asked);

    expect(await settled(s.port)).toBe(false);
    const right = await get(s.port, fromTheEdge);
    const wrong = await get(s.port, wrongProof);
    for (const r of [right, wrong]) {
      expect(r.status).toBe(503);
      expect(r.retryAfter).toBe("1");
    }
    expect(withoutId(right.body)).toEqual({
      ok: false,
      error: "Den is starting. Try again in a moment.",
      code: "edge_starting",
    });
    expect(withoutId(wrong.body)).toEqual(withoutId(right.body));
    const page = await get(s.port, { ...fromTheEdge, accept: "text/html" }, "/");
    expect([page.status, page.type, page.retryAfter]).toEqual([
      503,
      expect.stringMatching(/text\/html/),
      "1",
    ]);
    expect(page.body).toContain('"code":"edge_starting"');
    expect((await get(s.port, fromTheEdge, "/shell.js")).status).toBe(200);
    expect((await get(s.port, {})).status).toBe(200);

    h.release();
    await until(async () => (await settled(s.port)) === true);
    expect((await get(s.port, fromTheEdge)).status).toBe(200);
    expect((await get(s.port, wrongProof)).status).toBe(401);
  }, 60_000);

  it("a test's server is up only once the edge start has settled, so its first edge request is trusted", async () => {
    const h = heldEdgeStart();
    tmp = h.tmp;
    const port = await freePort();
    let up = false;
    const starting = h.start(true, port).then((s) => {
      up = true;
      server = s.server;
      return s;
    });
    await until(h.asked);
    await until(async () => {
      try {
        return (await settled(port)) === false;
      } catch {
        return false;
      }
    });
    await Promise.race([starting, new Promise((r) => setTimeout(r, 1_000))]);
    expect(up).toBe(false);

    h.release();
    const s = await starting;
    expect(await settled(s.port)).toBe(true);
    expect((await get(s.port, fromTheEdge)).status).toBe(200);
  }, 60_000);
});
