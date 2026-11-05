/**
 * The health row never reads a service down before its check has answered.
 * A check that has not answered within its budget is pending (ok null,
 * pending: true); "docker state unknown" is unknown, not "not running". Only
 * a check that completed and failed is ok:false.
 *
 * The real web server in a throwaway distribution. Delay shims make the race
 * deterministic: a shell check that answers after 6s (past the 5s budget),
 * and a `docker` whose listing answers late, or not at all.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import { spawnSync } from "child_process";
import * as http from "http";
import * as net from "net";
import * as os from "os";
import * as path from "path";
import {
  startSlowGitServer,
  write,
  type SlowGitServer,
} from "./helpers/slow-git-server.js";

const ENGINE = path.resolve(__dirname, "../../..");

interface Result {
  repo: string;
  service: string;
  ok: boolean | null;
  pending?: boolean;
  error?: string;
}

/** Every result /api/health/stream sends, with when it arrived. */
function stream(port: number): Promise<{ at: number; r: Result }[]> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const got: { at: number; r: Result }[] = [];
    const req = http.get(
      {
        host: "127.0.0.1",
        port,
        path: "/api/health/stream?refresh=1",
        agent: false,
        timeout: 30_000,
      },
      (res) => {
        let buf = "";
        res.on("data", (d: Buffer) => {
          buf += d.toString();
          let i;
          while ((i = buf.indexOf("\n\n")) !== -1) {
            const line = buf.slice(0, i).replace(/^data: /, "");
            buf = buf.slice(i + 2);
            const msg = JSON.parse(line) as { type: string; result?: Result };
            if (msg.type === "result" && msg.result)
              got.push({ at: Date.now() - started, r: msg.result });
          }
        });
        res.on("end", () => resolve(got));
      },
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("stream timeout")));
  });
}

/**
 * A distribution whose default workspace holds `slow` (a shell check that
 * answers healthy after 6s) and `shop`, a compose stack checked by
 * `den stack health` against the `docker` shim given.
 */
function makeDist(
  tmp: string,
  docker: string,
  slowCmd = "sleep 6; exit 0",
  hangUrl?: string,
): string {
  const root = path.join(tmp, "den");
  const repos = path.join(tmp, "repos");
  write(path.join(root, "den.yml"), "product:\n  name: den\n");
  write(
    path.join(root, "config", "den.yml"),
    "environments: [local]\nedge:\n  org: acme\n  domain: acme.localhost\n",
  );
  write(
    path.join(root, "bin", "den"),
    `#!/bin/sh\nexec ${JSON.stringify(path.join(ENGINE, "bin", "den"))} "$@"\n`,
    0o755,
  );
  write(
    path.join(root, "config", "local", "service-catalog.yml"),
    "slow:\n  gh: acme/slow\nshop:\n  gh: acme/shop\nhang:\n  gh: acme/hang\n",
  );
  write(
    path.join(root, "config", "local", "workspaces.yml"),
    [
      "active: [default]",
      "focus: default",
      "workspaces:",
      "  default:",
      "    services:",
      ...["slow", "shop", ...(hangUrl ? ["hang"] : [])].flatMap((r) => [
        `      ${r}:`,
        "        mode: dev-managed",
        `        path: ${path.join(repos, r)}`,
      ]),
      "",
    ].join("\n"),
  );
  write(
    path.join(repos, "slow", ".den.yml"),
    [
      "name: slow",
      "services:",
      "  api:",
      "    commands: { local: { up: 'true' } }",
      "    health:",
      `      local: { type: shell, cmd: '${slowCmd}' }`,
      "",
    ].join("\n"),
  );
  write(
    path.join(repos, "shop", ".den.yml"),
    [
      "name: shop",
      "compose:",
      "  name: shopdb",
      "services:",
      "  api: {}",
      "",
    ].join("\n"),
  );
  write(path.join(repos, "shop", "docker-compose.yml"), "services: {}\n");
  if (hangUrl)
    write(
      path.join(repos, "hang", ".den.yml"),
      [
        "name: hang",
        "services:",
        "  web:",
        "    commands: { local: { up: 'true' } }",
        "    health:",
        `      local: { type: http, url: '${hangUrl}' }`,
        "",
      ].join("\n"),
    );
  write(path.join(tmp, "shim", "docker"), docker, 0o755);
  return root;
}

/** A docker whose `ps` lists shop's container as Up (healthy) after `delayS`. */
const lateDocker = (delayS: number) =>
  [
    "#!/bin/sh",
    `sleep ${delayS}`,
    "printf 'api\\trunning\\tUp 2 hours (healthy)\\n'",
    "",
  ].join("\n");

/** Each server's throwaway directory (its dist and repos live under it). */
const dirs = new WeakMap<SlowGitServer, string>();

async function withServer<T>(
  docker: string,
  work: (srv: SlowGitServer) => Promise<T>,
  slowCmd?: string,
  hangUrl?: string,
): Promise<T> {
  const tmp = fs.mkdtempSync(path.join(tmpBase, "case-"));
  const root = makeDist(tmp, docker, slowCmd, hangUrl);
  const savedPath = process.env.PATH;
  process.env.PATH = `${path.join(tmp, "shim")}:${savedPath ?? ""}`;
  let srv: SlowGitServer | null = null;
  try {
    srv = await startSlowGitServer({ tmp, root, slow: [], delayS: 0 });
    dirs.set(srv, tmp);
    return await work(srv);
  } finally {
    process.env.PATH = savedPath;
    await srv?.stop();
  }
}

/** An HTTP endpoint that accepts connections and never answers. */
async function hangingServer(): Promise<{ url: string; close: () => void }> {
  const sockets: net.Socket[] = [];
  const srv = net.createServer((s) => sockets.push(s));
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const { port } = srv.address() as net.AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/health`,
    close: () => {
      for (const s of sockets) s.destroy();
      srv.close();
    },
  };
}

/** `den status` (no TTY) against a distribution. */
function denStatus(tmp: string): string {
  const root = path.join(tmp, "den");
  const r = spawnSync(path.join(root, "bin", "den"), ["status"], {
    cwd: root,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      PATH: `${path.join(tmp, "shim")}:${process.env.PATH ?? ""}`,
      DEN_ROOT: root,
      DEN_HOME: path.join(tmp, "home"),
      DEN_DAEMONS_FILE: path.join(tmp, "daemons.json"),
      FORCE_COLOR: "0",
      NO_COLOR: "1",
    },
    timeout: 60_000,
  });
  return `${r.stdout}${r.stderr}`;
}

/** A shell check that misses its budget on its first run only. */
const SLOW_ONCE =
  'if [ -f "$DEN_ROOT/../answered" ]; then exit 0; fi; touch "$DEN_ROOT/../answered"; sleep 6';

let tmpBase = "";
beforeAll(() => {
  tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "den-health-pending-"));
});
afterAll(() => {
  fs.rmSync(tmpBase, { recursive: true, force: true });
});

describe("health: pending is not down", () => {
  it("a check that answers after its budget is pending, never ok:false", async () => {
    const got = await withServer(lateDocker(0), (srv) => stream(srv.port));
    const slow = got.filter((g) => g.r.repo === "slow");
    expect(slow).toHaveLength(1);
    expect(slow[0].r.ok).not.toBe(false);
    expect(slow[0].r).toEqual(
      expect.objectContaining({ ok: null, pending: true }),
    );
    // Control: the healthy stack, answered in time, reads up.
    const shop = got.find((g) => g.r.repo === "shop");
    expect(shop?.r).toEqual(expect.objectContaining({ ok: true }));
  }, 90_000);

  it("a docker listing that answers late: no service reads down", async () => {
    const got = await withServer(lateDocker(7), (srv) => stream(srv.port));
    const shop = got.filter((g) => g.r.repo === "shop");
    expect(shop).toHaveLength(1);
    expect(shop[0].r.ok).not.toBe(false);
    expect(shop[0].r.ok).toBeNull();
    for (const g of got) expect(g.r.ok).not.toBe(false);
  }, 90_000);

  it("a docker listing that answers late but in time: up, never down first", async () => {
    const got = await withServer(lateDocker(2), (srv) => stream(srv.port));
    const shop = got.filter((g) => g.r.repo === "shop");
    expect(shop.map((g) => g.r.ok)).toEqual([true]);
  }, 90_000);

  it("a stream and a poll at once share one run: each check runs once", async () => {
    const counted = await withServer(
      lateDocker(0),
      async (srv) => {
        await Promise.all([
          stream(srv.port),
          srv.timed("/api/health?refresh=1"),
          stream(srv.port),
        ]);
        const log = path.join(dirs.get(srv)!, "runs.log");
        return fs.readFileSync(log, "utf-8").split("\n").filter(Boolean).length;
      },
      // Counts its runs; DEN_ROOT (the dist) is under the case directory.
      'echo run >> "$DEN_ROOT/../runs.log"; sleep 1',
    );
    expect(counted).toBe(1);
  }, 90_000);

  it("docker unavailable: the stack's state is unknown, not down", async () => {
    const got = await withServer(
      "#!/bin/sh\necho 'Cannot connect to the Docker daemon' >&2\nexit 1\n",
      (srv) => stream(srv.port),
    );
    const shop = got.find((g) => g.r.repo === "shop");
    expect(shop?.r.ok).toBeNull();
    expect(shop?.r.pending).toBeUndefined();
  }, 90_000);

  it("a stopped stack (docker answered: nothing running) is down", async () => {
    const got = await withServer("#!/bin/sh\nexit 0\n", (srv) =>
      stream(srv.port),
    );
    const shop = got.find((g) => g.r.repo === "shop");
    expect(shop?.r.ok).toBe(false);
  }, 90_000);
});

describe("health: a timeout is pending once, down when repeated", () => {
  it("HTTP: the first cycle's timeout is pending, the next consecutive one is down", async () => {
    const hang = await hangingServer();
    try {
      const [first, second] = await withServer(
        lateDocker(0),
        async (srv) => [await stream(srv.port), await stream(srv.port)],
        "exit 0",
        hang.url,
      );
      const h1 = first.find((g) => g.r.repo === "hang")!.r;
      const h2 = second.find((g) => g.r.repo === "hang")!.r;
      expect(h1).toEqual(
        expect.objectContaining({ ok: null, pending: true, error: "timeout" }),
      );
      expect(h2).toEqual(
        expect.objectContaining({
          ok: false,
          error: "timeout (twice in a row)",
        }),
      );
    } finally {
      hang.close();
    }
  }, 90_000);

  it("shell: a check slow on its first cycle only is pending, then up, never down", async () => {
    const [first, second] = await withServer(
      lateDocker(0),
      async (srv) => [await stream(srv.port), await stream(srv.port)],
      SLOW_ONCE,
    );
    const s1 = first.find((g) => g.r.repo === "slow")!.r;
    const s2 = second.find((g) => g.r.repo === "slow")!.r;
    expect(s1).toEqual(expect.objectContaining({ ok: null, pending: true }));
    expect(s2.ok).toBe(true);
  }, 90_000);

  it("`den status` agrees: one timeout then an answer is up; repeated timeouts are down", async () => {
    const hang = await hangingServer();
    try {
      const tmp = fs.mkdtempSync(path.join(tmpBase, "status-"));
      makeDist(tmp, lateDocker(0), SLOW_ONCE, hang.url);
      const out = denStatus(tmp);
      const line = (repo: string) =>
        out.split("\n").find((l) => new RegExp(`\\b${repo}\\b`).test(l)) ?? "";
      expect(line("slow")).toMatch(/ok/);
      expect(line("slow")).not.toMatch(/down/);
      expect(line("hang")).toMatch(/down/);
    } finally {
      hang.close();
    }
  }, 90_000);
});
