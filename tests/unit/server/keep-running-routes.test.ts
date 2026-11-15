/**
 * Issue 163: Settings › Keep agents running after logout › Apply
 * (POST /api/keep-running-after-logout {on}). It re-installs Den's launchd jobs
 * through `service install --mode <m>` (cmdService), detached in the real
 * server. The admin password is asked only when sudo will run: for
 * always, or to remove the LaunchDaemons a login install replaces; never
 * for login over login. A refusal leaves the old mode and the Setting.
 *
 * The first block fakes the installer; the second runs the real
 * service/install.sh through cmdService under shims (launchctl and sudo
 * are shims: nothing reaches this machine's launchd or root).
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
} from "@jest/globals";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as http from "http";
import type { AddressInfo } from "net";
import * as os from "os";
import * as path from "path";
import {
  handleKeepRunningRoutes,
  type KeepRunningDeps,
} from "../../../src/ui/server/keep-running-routes.js";
import { cmdService } from "../../../src/ui/cli/service-command.js";
import type { ServiceMode } from "../../../src/ui/cli/doctor-where.js";

const tmps: string[] = [];
afterEach(() => {
  for (const d of tmps.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});

/** A world the route sees: what is installed, saved and run. */
interface World {
  installed: ServiceMode | null;
  sudoReady: boolean;
  saved: (boolean | null)[];
  installs: ServiceMode[];
  installCode: number;
  platform: NodeJS.Platform;
}

let world: World;
const fresh = (over: Partial<World> = {}): World => ({
  installed: "login",
  sudoReady: false,
  saved: [],
  installs: [],
  installCode: 0,
  platform: "darwin",
  ...over,
});

let installImpl: (mode: ServiceMode) => Promise<number> = async (mode) => {
  world.installs.push(mode);
  return world.installCode;
};

const deps: KeepRunningDeps = {
  isAgent: (r) => r.headers["x-den-actor"] === "agent",
  platform: () => world.platform,
  installed: () => world.installed,
  sudoReady: () => world.sudoReady,
  save: (on) => void world.saved.push(on),
  install: (mode) => installImpl(mode),
  cli: "acme",
  readBody: (req) =>
    new Promise((ok) => {
      let b = "";
      req.on("data", (c) => (b += c));
      req.on("end", () => ok(b));
    }),
  sendJson: (res, body, status = 200) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  },
};

let server: http.Server;
let base = "";
beforeAll(async () => {
  server = http.createServer((req, res) => {
    const p = new URL(req.url ?? "/", "http://x").pathname;
    if (!handleKeepRunningRoutes(req, res, p, deps)) {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const apply = async (on: unknown, agent = false) => {
  const r = await fetch(`${base}/api/keep-running-after-logout`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(agent ? { "x-den-actor": "agent" } : {}),
    },
    body: JSON.stringify({ on }),
  });
  return {
    status: r.status,
    body: (await r.json()) as Record<string, unknown>,
  };
};

describe("Apply: when it asks for the admin password", () => {
  it("on, sudo not ready: asks (needs-sudo), saves nothing, installs nothing", async () => {
    world = fresh({ installed: "login", sudoReady: false });
    const r = await apply(true);
    expect(r.body).toMatchObject({
      ok: false,
      needsSudo: { command: "acme service install --mode always" },
    });
    expect(world.saved).toEqual([]);
    expect(world.installs).toEqual([]);
  });

  it("on, sudo ready: saves on, then installs always", async () => {
    world = fresh({ installed: "login", sudoReady: true });
    const r = await apply(true);
    expect(r.body).toMatchObject({ ok: true, applied: true, mode: "always" });
    expect(world.saved).toEqual([true]);
    expect(world.installs).toEqual(["always"]);
  });

  it("off over login: never asks, even with no password", async () => {
    world = fresh({ installed: "login", sudoReady: false });
    const r = await apply(false);
    expect(r.body).toMatchObject({ ok: true, applied: false, mode: "login" });
    expect(r.body.needsSudo).toBeUndefined();
    expect(world.saved).toEqual([false]);
    expect(world.installs).toEqual([]);
  });

  it("off over always: sudo runs to remove the daemons, so it asks; then installs login", async () => {
    world = fresh({ installed: "always", sudoReady: false });
    expect((await apply(false)).body).toMatchObject({
      ok: false,
      needsSudo: { command: "acme service install --mode login" },
    });
    expect(world.installs).toEqual([]);
    world.sudoReady = true;
    expect((await apply(false)).body).toMatchObject({
      ok: true,
      applied: true,
      mode: "login",
    });
    expect(world.installs).toEqual(["login"]);
  });

  it("not running as a service: saves, says how it applies, installs nothing", async () => {
    world = fresh({ installed: null, sudoReady: false });
    const r = await apply(true);
    expect(r.body).toMatchObject({ ok: true, applied: false });
    expect(String(r.body.message)).toContain("acme service install");
    expect(world.saved).toEqual([true]);
    expect(world.installs).toEqual([]);
  });

  it("an install that fails to start: the Setting goes back", async () => {
    world = fresh({ installed: "login", sudoReady: true, installCode: 1 });
    const r = await apply(true);
    expect(r.status).toBe(500);
    expect(world.saved).toEqual([true, null]);
  });

  it("refuses an agent, a non-boolean, and off macOS", async () => {
    world = fresh({ sudoReady: true });
    expect((await apply(true, true)).status).toBe(403);
    expect((await apply("yes")).status).toBe(400);
    world = fresh({ sudoReady: true, platform: "linux" });
    expect((await apply(true)).status).toBe(409);
    expect(world.saved).toEqual([]);
    expect(world.installs).toEqual([]);
  });
});

const mac = process.platform === "darwin" ? it : it.skip;

describe("Apply through the real install.sh (shims)", () => {
  const root = path.resolve(__dirname, "../../..");
  const dist = path.join(root, "examples", "distribution");

  /** Shims for launchctl and sudo; `sudoOk` false: sudo refuses. */
  function rig(sudoOk: boolean) {
    const t = fs.mkdtempSync(path.join(os.tmpdir(), "den-keep-run-"));
    tmps.push(t);
    const bin = path.join(t, "shims");
    fs.mkdirSync(bin);
    const calls = path.join(t, "calls.log");
    const shim = (name: string, body: string) =>
      fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, {
        mode: 0o755,
      });
    shim(
      "launchctl",
      `echo "launchctl $*" >> "${calls}"\n[ "$1" = print ] && exit 113\nexit 0`,
    );
    shim(
      "fakesudo",
      sudoOk
        ? `echo "sudo $*" >> "${calls}"\nif [ "$1" = install ]; then shift; while [ "$1" = -o ] || [ "$1" = -g ]; do shift 2; done; exec install "$@"; fi\nexec "$@"`
        : `echo "sudo $*" >> "${calls}"\necho "sudo: a password is required" >&2\nexit 1`,
    );
    shim(
      "codesign",
      `echo "designated => identifier node and certificate leaf[subject.OU] = TEAM1"`,
    );
    shim("otool", `echo "$2:"`);
    const node = path.join(t, "node-a");
    fs.writeFileSync(node, "#!/bin/sh\necho 22\n", { mode: 0o755 });
    const home = path.join(t, "home");
    const agents = path.join(home, "Library", "LaunchAgents");
    fs.mkdirSync(agents, { recursive: true });
    const daemons = path.join(t, "LaunchDaemons");
    fs.mkdirSync(daemons);
    const env = {
      PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
      HOME: home,
      DEN_SERVICE_NODE: node,
      DEN_SERVICE_DAEMON_DIR: daemons,
      DEN_SERVICE_SUDO: path.join(bin, "fakesudo"),
    };
    /** The installer the server builds: cmdService, handed off. */
    const install = async (mode: ServiceMode) =>
      cmdService(["install", "--mode", mode], {
        handOff: true,
        run: (cmd, args, e) =>
          spawnSync(cmd, args, { encoding: "utf-8", env: { ...env, ...e } })
            .status ?? 1,
        stateDir: path.join(t, "state"),
        config: { environments: ["local"] } as never,
        job: () => null,
        jobPid: () => null,
        distRoot: dist,
        engineRoot: root,
        home,
        platform: "darwin",
        webPort: 7001,
        log: () => {},
        identify: async () => ({ kind: "none" }),
      });
    return { t, agents, daemons, calls, install };
  }

  mac("on: both jobs become LaunchDaemons running as the person", async () => {
    const r = rig(true);
    installImpl = r.install;
    world = fresh({ installed: "login", sudoReady: true });
    expect((await apply(true)).body).toMatchObject({
      ok: true,
      mode: "always",
    });
    expect(fs.readdirSync(r.daemons).sort()).toEqual([
      "local.distribution.sessions.plist",
      "local.distribution.web.plist",
    ]);
    for (const l of ["web", "sessions"])
      expect(
        fs.readFileSync(
          path.join(r.daemons, `local.distribution.${l}.plist`),
          "utf-8",
        ),
      ).toContain(
        `<key>UserName</key>\n\t<string>${os.userInfo().username}</string>`,
      );
  });

  mac(
    "sudo refused: the LaunchAgents stay and the Setting goes back",
    async () => {
      const r = rig(false);
      for (const l of ["web", "sessions"])
        fs.writeFileSync(
          path.join(r.agents, `local.distribution.${l}.plist`),
          "old",
        );
      installImpl = r.install;
      world = fresh({ installed: "login", sudoReady: true });
      expect((await apply(true)).status).toBe(500);
      expect(world.saved).toEqual([true, null]);
      expect(fs.readdirSync(r.daemons)).toEqual([]);
      for (const l of ["web", "sessions"])
        expect(
          fs.readFileSync(
            path.join(r.agents, `local.distribution.${l}.plist`),
            "utf-8",
          ),
        ).toBe("old");
    },
  );
});
