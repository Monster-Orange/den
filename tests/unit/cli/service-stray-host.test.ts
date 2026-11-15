/**
 * Drill (c), 0.4.48: `service install` on a Den whose agents run on a host
 * the service didn't start (one from a terminal or an older web server).
 * The service's host never takes a socket another host answers on: it
 * waits for that one to end. Install (and status) now say so plainly,
 * with how many it runs, instead of nothing.
 *
 * The runner is injected (nothing calls launchctl or bash); askLiveHost
 * talks to a real host on a temp state dir's socket, behind a scripted PTY.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { ServiceJob } from "../../../src/ui/cli/doctor-where.js";
import {
  askLiveHost,
  cmdService,
  strayHostLine,
  type LiveHost,
} from "../../../src/ui/cli/service-command.js";
import type { DenConfig } from "../../../src/shared/den-config.js";
import { connectHost } from "../../../src/shared/sessions/client.js";
import { SessionHost } from "../../../src/shared/sessions/host.js";
import { scriptedFactory } from "../sessions/helpers/fake-pty.js";

const tmps: string[] = [];
const hosts: SessionHost[] = [];
afterEach(async () => {
  for (const h of hosts.splice(0)) await h.close();
  for (const d of tmps.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "den-stray-"));
  tmps.push(d);
  return d;
};

const job: ServiceJob = {
  state: "loaded",
  mode: "login",
  plist: "/home/someone/Library/LaunchAgents/local.acme-dev.web.plist",
  domain: "gui/501",
};

/** cmdService's seams: the web job 30000, the host job `hostPid`. */
function deps(live: LiveHost | null, hostPid: number | null) {
  const lines: string[] = [];
  return {
    lines,
    deps: {
      run: () => 0,
      stateDir: tmp(),
      job: () => job,
      jobPid: (_j: ServiceJob, label: string) =>
        label.endsWith(".sessions") ? hostPid : 30000,
      stopPlain: async () => true,
      recordOwner: () => ({ state: "linked" as const }),
      config: { environments: ["local"] } as DenConfig,
      distRoot: "/src/acme-dev",
      home: "/home/someone",
      engineRoot: "/src/acme-dev/node_modules/@monster-orange/den",
      platform: "darwin" as NodeJS.Platform,
      log: (l: string) => lines.push(l),
      webPort: 7001,
      waitReady: async () => true,
      identify: async () => ({ kind: "ours" as const, pid: 30000 }),
      liveHost: async () => live,
    },
  };
}

describe("drill (c): a host the service didn't start", () => {
  it("install names it, how many it runs, and that no second host starts beside it", async () => {
    const h = deps({ pid: 2240, running: 2 }, 80617);
    expect(await cmdService(["install"], h.deps)).toBe(0);
    const out = h.lines.join("\n");
    expect(out).toContain(
      "! A host the service didn't start (pid 2240) is running 2 agents or terminals.",
    );
    expect(out).toContain(
      "The service's host waits until that one ends, and never starts a second one beside it.",
    );
    expect(out).toContain(
      "When this Mac restarts, they start again under the service.",
    );
  });

  it("status says it too", async () => {
    const h = deps({ pid: 2240, running: 1 }, 80617);
    await cmdService(["status"], h.deps);
    expect(h.lines.join("\n")).toContain(
      "(pid 2240) is running 1 agent or terminal.",
    );
  });

  it("nothing to say when the service's own host answers, or none does", async () => {
    for (const live of [{ pid: 80617, running: 3 }, null]) {
      const h = deps(live, 80617);
      expect(await cmdService(["install"], h.deps)).toBe(0);
      expect(h.lines.join("\n")).not.toContain("A host the service");
    }
  });

  it("a host with nothing running: the service's host takes over at the restart", () => {
    expect(strayHostLine({ pid: 2240, running: 0 }, null)).toContain(
      "is running nothing.",
    );
    expect(strayHostLine({ pid: 2240, running: 0 }, null)).toContain(
      "the service's host takes over",
    );
  });
});

describe("askLiveHost: the host on the socket", () => {
  it("names a real host's pid and counts what it runs, not what exited", async () => {
    const dir = tmp();
    const { factory } = scriptedFactory();
    const host = new SessionHost({
      stateDir: dir,
      pty: () => ({ available: true, factory }),
      flushMs: 0,
      log: () => undefined,
    });
    hosts.push(host);
    await host.listen();
    const c = await connectHost(path.join(dir, "sessions.sock"));
    await c.start({
      name: "acme-north:planner",
      cwd: dir,
      argv: ["sh", "-c", "true"],
      env: { PATH: "/usr/bin:/bin" },
      cols: 80,
      rows: 24,
    });
    c.close();
    expect(await askLiveHost(dir)).toEqual({ pid: process.pid, running: 1 });
  });

  it("no host on the socket: null, at once", async () => {
    const t = Date.now();
    expect(await askLiveHost(tmp())).toBeNull();
    expect(Date.now() - t).toBeLessThan(2000);
  });

  it("a second host on a taken socket stands down: the first one keeps it", async () => {
    const dir = tmp();
    const mk = () =>
      new SessionHost({
        stateDir: dir,
        pty: () => ({ available: true, factory: scriptedFactory().factory }),
        flushMs: 0,
        log: () => undefined,
      });
    const first = mk();
    const second = mk();
    hosts.push(first, second);
    expect(await first.listen()).toBe("listening");
    expect(await second.listen()).toBe("already-running");
  });
});
