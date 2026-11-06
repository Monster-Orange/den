/**
 * Records from before 0.3.0-dev.37 reach adoption from the CLI
 * (0.3.0-dev.39, a consumer's dev.38 finding). dev.38 decided right when
 * adoptLegacyProcess was called, but the CLI's paths skipped it: `up
 * <repo>`'s healthy-skip attached to the record and never settled it, `up
 * <repo>/<svc>` started a second server that died on EADDRINUSE and was
 * recorded, `down` of a service with an up of its own pointed at the repo's
 * down, a port held outside the repo took the healthy-skip silently, and
 * `restart` of a service with only an up was refused.
 *
 * Real bin/den in a throwaway distribution, real listener processes. Every
 * process this file starts (and every service den starts for it) carries
 * MARK on its command line and leads its own group; afterEach kills those
 * groups and nothing else.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
} from "@jest/globals";
import { execFileSync, spawn, spawnSync } from "child_process";
import * as fs from "fs";
import * as net from "net";
import * as os from "os";
import * as path from "path";

const ENGINE = path.resolve(__dirname, "../../..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "den-legacy-cli-"));
const MARK = `den-legacy-cli-${path.basename(tmp)}`;
let n = 0;

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

interface Dist {
  dir: string;
  root: string;
  repo: string;
  daemons: string;
  api: number;
  web: number;
}

async function freePort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const p = (s.address() as net.AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return p;
}

/** A distribution with one repo, `repox`: api (its entrypoint), web, bad. */
async function dist(): Promise<Dist> {
  const dir = path.join(tmp, `d${++n}`);
  const root = path.join(dir, "dist");
  const repo = path.join(dir, "repos", "repox");
  const api = await freePort();
  const web = await freePort();
  write(path.join(root, "den.yml"), "product:\n  name: den\n");
  write(path.join(root, "config", "den.yml"), "repos_root: ../repos\n");
  write(
    path.join(root, "config", "local", "service-catalog.yml"),
    "repox:\n  gh: x/repox\n",
  );
  write(
    path.join(root, "config", "local", "workspaces.yml"),
    `active: [default]\nfocus: default\nworkspaces:\n  default:\n    services:\n      repox:\n        mode: dev-managed\n        path: ${repo}\n`,
  );
  write(
    path.join(repo, "server.js"),
    `require("http").createServer((q, s) => s.end("ok")).listen(Number(process.argv[2]), "127.0.0.1");\n`,
  );
  const svc = (port: number) =>
    `    health:\n      local:\n        url: http://localhost:${port}/\n    commands:\n      local:\n        up: node server.js ${port} ${MARK}\n`;
  write(
    path.join(repo, ".den.yml"),
    `version: 1\nname: repox\nentrypoint: api\nservices:\n  api:\n${svc(api)}  web:\n${svc(web)}` +
      // An up that dies during startup.
      `  bad:\n    commands:\n      local:\n        up: node -e "process.exit(3)" ${MARK}\n`,
  );
  return {
    dir,
    root,
    repo,
    daemons: path.join(dir, "state", "daemons.json"),
    api,
    web,
  };
}

function den(d: Dist, ...args: string[]): { code: number; out: string } {
  const r = spawnSync(path.join(ENGINE, "bin", "den"), args, {
    cwd: d.root,
    encoding: "utf-8",
    input: "",
    // A minimal env: nothing of the developer's beyond PATH.
    env: {
      HOME: path.join(d.dir, "home"),
      PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin",
      DEN_ROOT: d.root,
      DEN_HOME: path.join(d.dir, "home", ".den"),
      DEN_DAEMONS_FILE: d.daemons,
      FORCE_COLOR: "0",
      NO_COLOR: "1",
    },
    timeout: 90_000,
  });
  return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
}

interface Rec {
  address: string;
  pgid?: number;
}
const records = (d: Dist): Rec[] => {
  try {
    return (
      JSON.parse(fs.readFileSync(d.daemons, "utf-8")) as { daemons: Rec[] }
    ).daemons;
  } catch {
    return [];
  }
};
const record = (d: Dist, address: string) =>
  records(d).find((r) => r.address === address);

/** A record as an up before 0.3.0-dev.37 wrote it: no process group. */
function legacy(d: Dist, address: string, extra: object = {}): void {
  const sub = address.includes("/") ? address.split("/")[1] : "api";
  const rest = records(d).filter((r) => r.address !== address);
  write(
    d.daemons,
    JSON.stringify({
      denPid: 1,
      daemons: [
        ...rest,
        {
          address,
          repoName: address.split("/")[0],
          subsystem: sub,
          repoPath: d.repo,
          branch: null,
          workspaces: ["default"],
          logPath: path.join(d.dir, "old.log"),
          startedAt: new Date().toISOString(),
          containers: [],
          ...extra,
        },
      ],
    }),
  );
}

/**
 * A listener on `port` with its cwd in `cwd`, leading its own group; with
 * `ownGroup`, in this test's process group instead (the group bin/den runs
 * in, so Den's own).
 */
async function listener(
  cwd: string,
  port: number,
  ownGroup = false,
): Promise<number> {
  fs.mkdirSync(cwd, { recursive: true });
  const p = spawn(
    process.execPath,
    [
      "-e",
      `require("http").createServer((q,s)=>s.end("ok")).listen(${port},"127.0.0.1")`,
      MARK,
    ],
    { cwd, detached: !ownGroup, stdio: "ignore" },
  );
  p.unref();
  await until(() => listening(port));
  return p.pid!;
}

function listening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const c = net.connect(port, "127.0.0.1");
    c.once("connect", () => {
      c.destroy();
      resolve(true);
    });
    c.once("error", () => resolve(false));
  });
}

async function until(
  cond: () => boolean | Promise<boolean>,
  ms = 8000,
): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return !!(await cond());
}

/** The live, marked processes: pid and pgid. */
function marked(): { pid: number; pgid: number }[] {
  return execFileSync("ps", ["-A", "-o", "pid=,pgid=,stat=,command="], {
    encoding: "utf-8",
  })
    .split("\n")
    .map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/))
    .filter((m): m is RegExpMatchArray => !!m && !m[3].startsWith("Z"))
    .filter((m) => m[4].includes(MARK))
    .map((m) => ({ pid: Number(m[1]), pgid: Number(m[2]) }));
}

/** This test process's own group: never signalled as a group. */
const OWN_PGID = Number(
  execFileSync("ps", ["-o", "pgid=", "-p", String(process.pid)], {
    encoding: "utf-8",
  }).trim(),
);

afterEach(async () => {
  for (const { pgid, pid } of marked()) {
    if (pgid === OWN_PGID) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* gone */
      }
      continue;
    }
    try {
      process.kill(-pgid, "SIGKILL");
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* gone */
      }
    }
  }
  await until(() => marked().length === 0, 3000);
});

beforeAll(() => {
  fs.mkdirSync(tmp, { recursive: true });
});
afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("a pre-dev.37 record from the CLI", () => {
  it("(a) up <repo> with a live in-repo listener adopts it and starts nothing; down <repo> stops it", async () => {
    const d = await dist();
    const pid = await listener(d.repo, d.api);
    legacy(d, "repox");
    const up = den(d, "up", "repox");
    expect(up.code).toBe(0);
    expect(up.out).toContain(`adopted pre-dev.37 process (pid ${pid}`);
    expect(record(d, "repox")?.pgid).toBe(pid);
    // Nothing else was started: the one marked process is the listener.
    expect(marked().map((m) => m.pid)).toEqual([pid]);
    const down = den(d, "down", "repox");
    expect(down.code).toBe(0);
    expect(await until(async () => !(await listening(d.api)))).toBe(true);
    expect(record(d, "repox")).toBeUndefined();
  }, 120_000);

  it("(b) up <repo>/<svc> adopts it too, and down <repo>/<svc> stops it", async () => {
    const d = await dist();
    const pid = await listener(d.repo, d.web);
    legacy(d, "repox/web");
    const up = den(d, "up", "repox/web");
    expect(up.code).toBe(0);
    expect(up.out).toContain(`adopted pre-dev.37 process (pid ${pid}`);
    expect(record(d, "repox/web")?.pgid).toBe(pid);
    expect(marked().map((m) => m.pid)).toEqual([pid]);
    const down = den(d, "down", "repox/web");
    expect(down.code).toBe(0);
    expect(await until(async () => !(await listening(d.web)))).toBe(true);
  }, 120_000);

  it("(c) a port held outside the repo is reported, never killed or adopted, and nothing starts on it", async () => {
    const d = await dist();
    const pid = await listener(path.join(d.dir, "elsewhere"), d.api);
    legacy(d, "repox");
    const up = den(d, "up", "repox");
    expect(up.code).toBe(1);
    expect(up.out).toMatch(
      new RegExp(`port ${d.api} is in use by pid ${pid} .*outside`),
    );
    expect(up.out).not.toContain("adopted");
    expect(await listening(d.api)).toBe(true);
    expect(marked().map((m) => m.pid)).toEqual([pid]);
    expect(record(d, "repox")).toBeUndefined();
  }, 120_000);

  it("(d) a stale record with nothing running is dropped, said, and the service starts fresh", async () => {
    const d = await dist();
    legacy(d, "repox");
    const up = den(d, "up", "repox");
    expect(up.code).toBe(0);
    expect(up.out).toMatch(
      /repox was recorded before 0\.3\.0-dev\.37.*dropped/,
    );
    expect(await until(() => listening(d.api))).toBe(true);
    expect(record(d, "repox")?.pgid).toEqual(expect.any(Number));
  }, 120_000);

  it("(e) down -a adopts and stops a legacy record's listener, and warns about a record outside every workspace", async () => {
    const d = await dist();
    const pid = await listener(d.repo, d.api);
    legacy(d, "repox");
    legacy(d, "ghost", { repoName: "ghost", repoPath: "/nonexistent/ghost" });
    const down = den(d, "down", "-a");
    expect(down.out).not.toContain("❌");
    expect(down.code).toBe(0);
    expect(down.out).toContain(`adopted pre-dev.37 process (pid ${pid}`);
    expect(await until(async () => !(await listening(d.api)))).toBe(true);
    expect(down.out).toMatch(/ghost is recorded as running .* left it alone/);
    expect(record(d, "ghost")).toBeDefined();
  }, 120_000);
});

describe("restart of a service with only an up", () => {
  it("stops the recorded group, then starts it again detached", async () => {
    const d = await dist();
    expect(den(d, "up", "repox/web").code).toBe(0);
    expect(await until(() => listening(d.web))).toBe(true);
    const first = record(d, "repox/web")?.pgid;
    expect(first).toEqual(expect.any(Number));
    const r = den(d, "restart", "repox/web");
    expect(r.out).not.toContain('command "restart" not found');
    expect(r.code).toBe(0);
    expect(await until(() => listening(d.web))).toBe(true);
    const second = record(d, "repox/web")?.pgid;
    expect(second).toEqual(expect.any(Number));
    expect(second).not.toBe(first);
    // The old group is gone: one marked group runs, the new one.
    expect([...new Set(marked().map((m) => m.pgid))]).toEqual([second]);
  }, 120_000);
});

describe("an up that exits during startup", () => {
  it("keeps no record and no process group of it", async () => {
    const d = await dist();
    const r = den(d, "up", "repox/bad");
    expect(r.code).toBe(1);
    expect(r.out).toContain("service exited 3 during startup");
    expect(record(d, "repox/bad")).toBeUndefined();
  }, 120_000);
});

describe("a named up whose port is held (0.3.0-dev.40)", () => {
  it("refuses before spawning when the port is held outside the repo (legacy record)", async () => {
    const d = await dist();
    const pid = await listener(path.join(d.dir, "elsewhere"), d.web);
    legacy(d, "repox/web");
    const up = den(d, "up", "repox/web");
    expect(up.code).toBe(1);
    expect(up.out).toMatch(
      new RegExp(`port ${d.web} is in use by pid ${pid} .*outside`),
    );
    expect(up.out).toContain("repox/web not started");
    expect(up.out).not.toContain("EADDRINUSE");
    // Nothing was spawned: the one marked process is the listener.
    expect(marked().map((m) => m.pid)).toEqual([pid]);
    expect(record(d, "repox/web")).toBeUndefined();
  }, 120_000);

  it("refuses before spawning when the port is held outside the repo (no record)", async () => {
    const d = await dist();
    const pid = await listener(path.join(d.dir, "elsewhere"), d.web);
    const up = den(d, "up", "repox/web");
    expect(up.code).toBe(1);
    expect(up.out).toContain("repox/web not started");
    expect(up.out).not.toContain("EADDRINUSE");
    expect(marked().map((m) => m.pid)).toEqual([pid]);
    expect(record(d, "repox/web")).toBeUndefined();
  }, 120_000);

  it("says a listener in Den's own process group is not adopted, not that it is outside the repo", async () => {
    const d = await dist();
    const pid = await listener(d.repo, d.web, true);
    legacy(d, "repox/web");
    const up = den(d, "up", "repox/web");
    expect(up.code).toBe(1);
    expect(up.out).toContain(
      `port ${d.web} is in use by pid ${pid} (cwd ${fs.realpathSync(d.repo)}), in Den's own process group; not adopted`,
    );
    expect(up.out).not.toContain("outside");
    expect(marked().map((m) => m.pid)).toEqual([pid]);
  }, 120_000);
});

describe("up --dry-run on a pre-dev.37 record (0.3.0-dev.40)", () => {
  const unchanged = (d: Dist, run: () => void): void => {
    const before = fs.readFileSync(d.daemons, "utf-8");
    run();
    expect(fs.readFileSync(d.daemons, "utf-8")).toBe(before);
  };

  it("says it would adopt the in-repo listener, and signals and writes nothing", async () => {
    const d = await dist();
    const pid = await listener(d.repo, d.web);
    legacy(d, "repox/web");
    unchanged(d, () => {
      const r = den(d, "up", "repox/web", "--dry-run");
      expect(r.code).toBe(0);
      expect(r.out).toContain(`would adopt pid ${pid} (port ${d.web})`);
    });
    expect(await listening(d.web)).toBe(true);
    expect(record(d, "repox/web")?.pgid).toBeUndefined();
  }, 120_000);

  it("says it would drop the record when nothing runs", async () => {
    const d = await dist();
    legacy(d, "repox/web");
    unchanged(d, () => {
      const r = den(d, "up", "repox/web", "--dry-run");
      expect(r.code).toBe(0);
      expect(r.out).toContain("would drop the record (nothing running)");
    });
    expect(marked()).toEqual([]);
  }, 120_000);

  it("says a port held outside the repo would not start", async () => {
    const d = await dist();
    const pid = await listener(path.join(d.dir, "elsewhere"), d.web);
    legacy(d, "repox/web");
    unchanged(d, () => {
      const r = den(d, "up", "repox/web", "--dry-run");
      expect(r.code).toBe(1);
      expect(r.out).toContain(
        `port ${d.web} held outside the repo: would not start`,
      );
    });
    expect(marked().map((m) => m.pid)).toEqual([pid]);
  }, 120_000);
});

describe("down under a config that fails validation (0.3.0-dev.40)", () => {
  const invalid = (d: Dist): void =>
    write(
      path.join(d.root, "config", "den.yml"),
      "repos_root: ../repos\norgs:\n  acme:\n    sources: not-a-list\n",
    );

  it("down <repo>/<svc> still stops a running service", async () => {
    const d = await dist();
    expect(den(d, "up", "repox/web").code).toBe(0);
    expect(await until(() => listening(d.web))).toBe(true);
    invalid(d);
    // The config does fail: an up is refused.
    const up = den(d, "up", "repox/api");
    expect(up.code).not.toBe(0);
    expect(up.out).toContain("orgs.acme.sources");
    const down = den(d, "down", "repox/web");
    // Said, not fatal.
    expect(down.out).toContain(
      "Stopping anyway, without the config's org data",
    );
    expect(down.out).not.toContain("❌");
    expect(down.code).toBe(0);
    expect(await until(async () => !(await listening(d.web)))).toBe(true);
    expect(record(d, "repox/web")).toBeUndefined();
  }, 120_000);

  it("down -a still stops a running service", async () => {
    const d = await dist();
    expect(den(d, "up", "repox/web").code).toBe(0);
    expect(await until(() => listening(d.web))).toBe(true);
    invalid(d);
    const down = den(d, "down", "-a");
    expect(down.out).not.toContain("❌");
    expect(down.code).toBe(0);
    expect(await until(async () => !(await listening(d.web)))).toBe(true);
    expect(record(d, "repox/web")).toBeUndefined();
  }, 120_000);
});
