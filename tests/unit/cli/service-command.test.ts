/**
 * `<cli> service install|status|print|uninstall`: the web UI's launchd
 * service, over Den's service/install.sh. The runner is injected, so nothing
 * here calls launchctl or bash.
 */
import { afterAll, afterEach, describe, expect, it } from "@jest/globals";
import * as http from "http";
import type { AddressInfo } from "net";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { ServiceJob } from "../../../src/ui/cli/doctor-where.js";
import {
  cmdService,
  waitForServerInfo,
  type ServiceRunner,
} from "../../../src/ui/cli/service-command.js";
import {
  readWebServiceConfig,
  type DenConfig,
} from "../../../src/shared/den-config.js";
import {
  ForeignServerError,
  type ServerIdentity,
} from "../../../src/ui/cli/server-identity.js";

const DIST = "/src/acme-dev";
const HOME = "/home/someone";
// Install writes the host job file here: a temp dir, never a real one.
const STATE = fs.mkdtempSync(path.join(os.tmpdir(), "den-svc-state-"));
afterAll(() => fs.rmSync(STATE, { recursive: true, force: true }));

const config = (web?: unknown): DenConfig =>
  ({ environments: ["local"], ...(web ? { web } : {}) }) as DenConfig;

describe("readWebServiceConfig", () => {
  it("defaults to what service/install.sh defaults to (the dist dir name)", () => {
    expect(readWebServiceConfig(config(), DIST, HOME)).toEqual({
      label: "local.acme-dev.web",
      logs: "/home/someone/Library/Logs/acme-dev",
    });
  });

  it("reads web.service.label and web.service.logs (~ expanded)", () => {
    expect(
      readWebServiceConfig(
        config({ port: 7001, service: { label: "com.acme.den", logs: "~/x" } }),
        DIST,
        HOME,
      ),
    ).toEqual({ label: "com.acme.den", logs: "/home/someone/x" });
  });

  it("resolves a relative logs dir under the distribution root", () => {
    expect(
      readWebServiceConfig(config({ service: { logs: "logs" } }), DIST, HOME)
        .logs,
    ).toBe(path.join(DIST, "logs"));
  });

  it("rejects a bad label, a non-string logs and unknown keys", () => {
    expect(() =>
      readWebServiceConfig(config({ service: { label: "a b/c" } }), DIST, HOME),
    ).toThrow(/web\.service\.label/);
    expect(() =>
      readWebServiceConfig(config({ service: { logs: 3 } }), DIST, HOME),
    ).toThrow(/web\.service\.logs/);
    expect(() =>
      readWebServiceConfig(config({ service: { lable: "x" } }), DIST, HOME),
    ).toThrow(/web\.service: unknown key "lable"/);
    expect(() =>
      readWebServiceConfig(config({ service: "x" }), DIST, HOME),
    ).toThrow(/web\.service must be a map/);
  });
});

function harness(
  over: {
    platform?: NodeJS.Platform;
    code?: number;
    web?: unknown;
    ready?: boolean;
    /** The poller finds another distribution's server: who it is. */
    foreign?: string;
    /** What answers on the port, for --plan and status. */
    identity?: ServerIdentity;
    /** What answers, call by call (then `identity`). */
    identities?: ServerIdentity[];
    /** D18: the job installed for the label. */
    job?: ServiceJob | null;
    /** D26: the job's pid. */
    jobPid?: number | null;
    /** D26: whether a plain server stops. */
    stops?: boolean;
  } = {},
) {
  const identified: number[] = [];
  const polls: { url: string; timeoutMs: number }[] = [];
  const calls: { cmd: string; args: string[]; env: Record<string, string> }[] =
    [];
  const run: ServiceRunner = (cmd, args, env) => {
    calls.push({ cmd, args, env });
    return over.code ?? 0;
  };
  const lines: string[] = [];
  const stopped: number[] = [];
  const deps = {
    run,
    stateDir: STATE,
    job: () => over.job ?? null,
    jobPid: () => over.jobPid ?? null,
    stopPlain: async (pid: number) => {
      stopped.push(pid);
      return over.stops ?? true;
    },
    config: config(over.web),
    distRoot: DIST,
    home: HOME,
    engineRoot: "/src/acme-dev/node_modules/@monster-orange/den",
    platform: over.platform ?? ("darwin" as NodeJS.Platform),
    log: (l: string) => lines.push(l),
    webPort: 7001,
    waitReady: async (url: string, timeoutMs: number) => {
      polls.push({ url, timeoutMs });
      if (over.foreign) throw new ForeignServerError(7001, over.foreign);
      return over.ready ?? true;
    },
    identify: async (port: number): Promise<ServerIdentity> => {
      identified.push(port);
      return over.identities?.shift() ?? over.identity ?? { kind: "none" };
    },
  };
  return { deps, calls, lines, polls, identified, stopped };
}

describe("cmdService", () => {
  it.each(["install", "status", "print", "uninstall"])(
    "%s runs service/install.sh with the distribution and the label",
    async (sub) => {
      const h = harness({
        web: { service: { label: "com.acme.den", logs: "/var/log/acme" } },
      });
      expect(await cmdService([sub], h.deps)).toBe(0);
      expect(h.calls).toEqual([
        {
          cmd: "bash",
          args: [
            "/src/acme-dev/node_modules/@monster-orange/den/service/install.sh",
            sub,
          ],
          env: {
            DEN_ROOT: DIST,
            DEN_SERVICE_LABEL: "com.acme.den",
            DEN_SERVICE_LOGS: "/var/log/acme",
            // D18: the mode, and Den's node copy for the session host.
            ...(sub === "install" || sub === "print"
              ? {
                  DEN_SERVICE_MODE: "login",
                  DEN_SERVICE_HOST_EXE: `${STATE}/bin/den-sessions-host`,
                }
              : {}),
            // install: the CLI, not the script, says when it is running.
            ...(sub === "install"
              ? { DEN_SERVICE_READY_CHECK: "external" }
              : {}),
          },
        },
      ]);
    },
  );

  it("passes the script's own defaults when the config sets nothing", async () => {
    const h = harness();
    await cmdService(["print"], h.deps);
    expect(h.calls[0].env).toEqual({
      DEN_ROOT: DIST,
      DEN_SERVICE_LABEL: "local.acme-dev.web",
      DEN_SERVICE_LOGS: "/home/someone/Library/Logs/acme-dev",
      DEN_SERVICE_MODE: "login",
      DEN_SERVICE_HOST_EXE: `${STATE}/bin/den-sessions-host`,
    });
  });

  it("returns the script's exit code, and polls nothing when it failed", async () => {
    const h = harness({ code: 1 });
    expect(await cmdService(["install"], h.deps)).toBe(1);
    expect(h.polls).toEqual([]);
  });

  it("install says running only once /api/server-info answers", async () => {
    const h = harness({ web: { service: { logs: "/var/log/acme" } } });
    expect(await cmdService(["install"], h.deps)).toBe(0);
    expect(h.polls).toEqual([
      { url: "http://localhost:7001/api/server-info", timeoutMs: 30_000 },
    ]);
    expect(h.lines.join("\n")).toMatch(
      /local\.acme-dev\.web running .*http:\/\/localhost:7001/,
    );
  });

  it("install that never answers: exit 1, pointing at the logs", async () => {
    const h = harness({
      ready: false,
      web: { service: { logs: "/var/log/acme" } },
    });
    expect(await cmdService(["install"], h.deps)).toBe(1);
    expect(h.lines.join("\n")).toMatch(
      /installed but not answering yet: check \/var\/log\/acme/,
    );
    expect(h.lines.join("\n")).not.toMatch(/ running/);
  });

  it("install that finds another distribution's server on the port: exit 1, never 'running'", async () => {
    const h = harness({ foreign: "acme-ops at /srv/acme-other" });
    expect(await cmdService(["install"], h.deps)).toBe(1);
    const out = h.lines.join("\n");
    expect(out).toMatch(
      /installed, but port 7001 is in use by acme-ops at \/srv\/acme-other/,
    );
    expect(out).toMatch(/pick another port/);
    expect(out).not.toMatch(/ running at/);
  });

  it.each(["status", "print", "uninstall"])("%s polls nothing", async (sub) => {
    const h = harness();
    await cmdService([sub], h.deps);
    expect(h.polls).toEqual([]);
  });

  it("refuses an unknown subcommand, and no subcommand, without running anything", async () => {
    const h = harness();
    await expect(cmdService(["start"], h.deps)).rejects.toThrow(
      /install \| status \| print \| uninstall/,
    );
    await expect(cmdService([], h.deps)).rejects.toThrow(
      /install \| status \| print \| uninstall/,
    );
    expect(h.calls).toEqual([]);
  });

  it("is macOS only, except print", async () => {
    const h = harness({ platform: "linux" });
    await expect(cmdService(["install"], h.deps)).rejects.toThrow(/macOS/);
    expect(h.calls).toEqual([]);
    expect(await cmdService(["print"], h.deps)).toBe(0);
    expect(h.calls).toHaveLength(1);
  });
});

describe("waitForServerInfo", () => {
  let server: http.Server | undefined;
  afterEach(async () => {
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    server = undefined;
  });

  const OWN = { root: DIST, product: "den" };

  /** A web server that answers with an empty body `empty` times first. */
  async function stub(
    empty: number,
    root: string = DIST,
    prod = "den",
  ): Promise<string> {
    let n = 0;
    server = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        n++ < empty
          ? ""
          : JSON.stringify({ pid: 1, version: "0.0.0", root, product: prod }),
      );
    });
    await new Promise<void>((r) => server!.listen(0, "localhost", r));
    return `http://localhost:${(server.address() as AddressInfo).port}/api/server-info`;
  }

  it("waits through empty bodies until valid JSON", async () => {
    const url = await stub(2);
    expect(await waitForServerInfo(url, 5_000, 20, OWN)).toBe(true);
  });

  it("gives up after the timeout", async () => {
    const url = await stub(Infinity);
    expect(await waitForServerInfo(url, 300, 20, OWN)).toBe(false);
  });

  it("another distribution's server answering is never 'running'", async () => {
    const url = await stub(0, "/srv/acme-other", "acme-ops");
    await expect(waitForServerInfo(url, 2_000, 20, OWN)).rejects.toThrow(
      /port \d+ is in use by acme-ops at \/srv\/acme-other/,
    );
  });
});

describe("service install --plan", () => {
  it("prints the label, paths and the plist, running only install.sh print", async () => {
    const h = harness({
      web: { service: { label: "com.acme.den", logs: "/var/log/acme" } },
      identity: { kind: "ours", version: "0.2.6", pid: 41 },
    });
    expect(await cmdService(["install", "--plan"], h.deps)).toBe(0);
    // Only the read-only print: no install, so no launchctl, no plist file.
    expect(h.calls.map((c) => c.args[1])).toEqual(["print"]);
    expect(h.calls[0].env.DEN_SERVICE_READY_CHECK).toBeUndefined();
    expect(h.polls).toEqual([]);
    expect(h.identified).toEqual([7001]);
    const out = h.lines.join("\n");
    expect(out).toMatch(/read-only: nothing is written or loaded/);
    expect(out).toMatch(/label: +com\.acme\.den/);
    expect(out).toMatch(
      /plist: +\/home\/someone\/Library\/LaunchAgents\/com\.acme\.den\.plist/,
    );
    expect(out).toMatch(/logs: +\/var\/log\/acme\/web\.log/);
    expect(out).toMatch(/root: +\/src\/acme-dev/);
    expect(out).toMatch(
      /server: +port 7001: this distribution's server \(Den 0\.2\.6\), pid 41/,
    );
  });

  it("D26: says install stops a plain server of this install first", async () => {
    const h = harness({
      identity: { kind: "ours", version: "0.2.6", pid: 41 },
    });
    expect(await cmdService(["install", "--plan"], h.deps)).toBe(0);
    expect(h.lines.join("\n")).toMatch(
      /install stops this plain server \(pid 41\) first; the service runs it then/,
    );
  });

  it("D26: says nothing of stopping when the job itself serves the port", async () => {
    const always: ServiceJob = {
      state: "loaded",
      mode: "always",
      plist: "/x.plist",
      domain: "system",
    };
    const h = harness({
      identity: { kind: "ours", version: "0.2.6", pid: 41 },
      job: always,
      jobPid: 41,
    });
    expect(await cmdService(["install", "--plan"], h.deps)).toBe(0);
    expect(h.lines.join("\n")).not.toMatch(/install stops/);
  });

  it("a free port: exit 0, says so", async () => {
    const h = harness({ identity: { kind: "none" } });
    expect(await cmdService(["install", "--plan"], h.deps)).toBe(0);
    expect(h.lines.join("\n")).toMatch(/port 7001: free/);
  });

  it("a foreign server on the port: exit 1, naming it", async () => {
    const h = harness({
      identity: { kind: "foreign", who: "acme-ops at /srv/acme-other" },
    });
    expect(await cmdService(["install", "--plan"], h.deps)).toBe(1);
    const out = h.lines.join("\n");
    expect(out).toMatch(
      /port 7001 is in use by acme-ops at \/srv\/acme-other; not this distribution's server/,
    );
    expect(out).toMatch(/install would refuse this port/);
    expect(h.calls.map((c) => c.args[1])).toEqual(["print"]);
  });

  it("works off macOS too (it loads nothing)", async () => {
    const h = harness({ platform: "linux" });
    expect(await cmdService(["install", "--plan"], h.deps)).toBe(0);
  });

  it("refuses an unknown flag before running anything (a typo must not install)", async () => {
    const h = harness();
    await expect(cmdService(["install", "--paln"], h.deps)).rejects.toThrow(
      /service install: unknown argument --paln \(takes --plan, --mode\)/,
    );
    await expect(cmdService(["status", "--plan"], h.deps)).rejects.toThrow(
      /service status: unknown argument --plan/,
    );
    expect(h.calls).toEqual([]);
  });
});

describe("service status", () => {
  it("names a foreign server on the port", async () => {
    const h = harness({
      identity: { kind: "foreign", who: "acme-ops at /srv/acme-other" },
    });
    expect(await cmdService(["status"], h.deps)).toBe(0);
    expect(h.lines.join("\n")).toMatch(
      /port 7001 is in use by acme-ops at \/srv\/acme-other; not this distribution's server/,
    );
  });

  it("says nothing more for our server or a free port", async () => {
    for (const identity of [
      { kind: "none" },
      { kind: "ours", version: "0.2.6" },
    ] as ServerIdentity[]) {
      const h = harness({ identity });
      await cmdService(["status"], h.deps);
      expect(h.lines).toEqual([]);
    }
  });
});

describe("D18: install modes", () => {
  const always: ServiceJob = {
    state: "loaded",
    mode: "always",
    plist: "/Library/LaunchDaemons/local.acme-dev.web.plist",
    domain: "system",
  };

  it("--mode always reaches the script; a bad mode is refused before anything runs", async () => {
    const h = harness();
    expect(await cmdService(["install", "--mode", "always"], h.deps)).toBe(0);
    expect(h.calls[0].env.DEN_SERVICE_MODE).toBe("always");
    const h2 = harness();
    await expect(
      cmdService(["install", "--mode=sometimes"], h2.deps),
    ).rejects.toThrow(/--mode takes login or always, not "sometimes"/);
    expect(h2.calls).toEqual([]);
  });

  it("without --mode, keeps the mode already installed", async () => {
    const h = harness({ job: always, jobPid: 4242 });
    await cmdService(["install"], h.deps);
    expect(h.calls[0].env.DEN_SERVICE_MODE).toBe("always");
  });

  it("--plan names the mode, the host job and the Full Disk Access path", async () => {
    const h = harness();
    expect(
      await cmdService(["install", "--plan", "--mode", "always"], h.deps),
    ).toBe(0);
    const out = h.lines.join("\n");
    expect(out).toContain(
      "mode:    always (LaunchDaemons running as you: kept across logout; one sudo)",
    );
    expect(out).toContain(
      "plist:   /Library/LaunchDaemons/local.acme-dev.web.plist",
    );
    expect(out).toContain(
      `host:    local.acme-dev.sessions on ${STATE}/bin/den-sessions-host`,
    );
  });

  it("install writes the host job file; uninstall removes it", async () => {
    const file = path.join(STATE, "sessions-host-job.json");
    fs.rmSync(file, { force: true });
    await cmdService(["install", "--mode", "always"], harness().deps);
    expect(JSON.parse(fs.readFileSync(file, "utf-8"))).toEqual({
      label: "local.acme-dev.sessions",
      mode: "always",
    });
    expect((fs.statSync(file).mode & 0o777).toString(8)).toBe("600");
    await cmdService(["uninstall"], harness().deps);
    expect(fs.existsSync(file)).toBe(false);
  });
});

describe("D26: running means the job's own process", () => {
  const job: ServiceJob = {
    state: "loaded",
    mode: "login",
    plist: "/home/someone/Library/LaunchAgents/local.acme-dev.web.plist",
    domain: "gui/501",
  };

  it("stops a plain server of this install on the port before installing", async () => {
    const h = harness({
      job,
      jobPid: 30000,
      identities: [
        { kind: "ours", pid: 27189 },
        { kind: "ours", pid: 30000 },
      ],
    });
    expect(await cmdService(["install"], h.deps)).toBe(0);
    expect(h.stopped).toEqual([27189]);
    expect(h.lines.join("\n")).toContain(
      "stopped the plain server of this install (pid 27189) on port 7001: the service runs it now",
    );
  });

  it("a plain server that won't stop: refused, nothing installed", async () => {
    const h = harness({ identity: { kind: "ours", pid: 27189 }, stops: false });
    expect(await cmdService(["install"], h.deps)).toBe(1);
    expect(h.calls).toEqual([]);
    expect(h.lines.join("\n")).toMatch(
      /pid 27189\) holds port 7001 and did not stop/,
    );
  });

  it("an answer from a pid that isn't the job's is not 'running'", async () => {
    // The job crash-loops (no pid): the old process still answers.
    const h = harness({
      job,
      jobPid: null,
      identities: [{ kind: "none" }, { kind: "ours", pid: 27189 }],
    });
    expect(await cmdService(["install"], h.deps)).toBe(1);
    const out = h.lines.join("\n");
    expect(out).toContain(
      "port 7001 is served by pid 27189, not the job (not running)",
    );
    expect(out).not.toMatch(/✓ .* running/);
  });

  it("status says when a plain server, not the job, holds the port", async () => {
    const h = harness({
      job,
      jobPid: 30000,
      identity: { kind: "ours", pid: 27189 },
    });
    expect(await cmdService(["status"], h.deps)).toBe(1);
    expect(h.lines.join("\n")).toContain(
      "port 7001 is served by pid 27189, not the service (pid 30000)",
    );
  });

  it("the job's own pid answering is running", async () => {
    const h = harness({
      job,
      jobPid: 30000,
      identity: { kind: "ours", pid: 30000 },
    });
    expect(await cmdService(["install"], h.deps)).toBe(0);
    expect(h.stopped).toEqual([]);
    expect(h.lines.join("\n")).toMatch(
      /✓ local\.acme-dev\.web running \(login\)/,
    );
  });
});
