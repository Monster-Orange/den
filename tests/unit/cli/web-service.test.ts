/**
 * `web up | down | restart` with the launchd service installed.
 *
 * Before: `web restart` stopped the job's server and started a plain one,
 * said "OK ... web started (pid N)", and launchd (KeepAlive) brought the
 * job back onto the port: the plain server died seconds later with "port in
 * use". Now restart goes through `launchctl kickstart -k` and reports the
 * job's new pid and the service log; up starts a job that is not answering;
 * down is refused (launchd would start it again). In always mode (system
 * domain) the sudo command is printed, never run.
 *
 * Fake launchd seams (setWebServiceDepsForTest): never the real launchctl.
 * owner-github is mocked: no gh, no write to the user's config.
 */
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import * as net from "net";

import {
  cmdWeb,
  setWebServiceDepsForTest,
} from "../../../src/ui/cli/web-command.js";
import {
  webServiceAction,
  type WebService,
} from "../../../src/ui/cli/web-service.js";

jest.mock("../../../src/shared/owner-github.js", () => ({
  recordOwnerGithub: () => ({ state: "linked" }),
  ownerGithubLine: () => null,
}));
type Svc = WebService;

async function freePort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, "localhost", () => r()));
  const port = (s.address() as net.AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

function fakeLaunchd(mode: "login" | "always" = "login") {
  const calls: { target: string; kill: boolean }[] = [];
  const lines: string[] = [];
  let pid = 31126;
  const svc: Svc = {
    label: "com.example.acme.web",
    log: "/Users/x/Library/Logs/acme/web.log",
    job: {
      state: "loaded",
      mode,
      plist: "/p.plist",
      domain: mode === "always" ? "system" : "gui/501",
    },
  };
  return {
    calls,
    lines,
    deps: {
      service: () => svc,
      kickstart: (target: string, kill: boolean) => {
        calls.push({ target, kill });
        pid += 1;
        return 0;
      },
      jobPid: () => pid,
      waitReady: async () => true,
      log: (l: string) => lines.push(l),
      pollMs: 1,
    },
  };
}

let logged: string[] = [];
const spy = () => {
  logged = [];
  jest.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
    logged.push(a.map(String).join(" "));
  });
};
afterEach(() => {
  setWebServiceDepsForTest(undefined);
  process.exitCode = undefined;
  jest.restoreAllMocks();
});

describe("web restart / up / down with the service installed", () => {
  it("restart kickstarts the job and names its pid and the service log; no plain server", async () => {
    const port = await freePort();
    const f = fakeLaunchd();
    setWebServiceDepsForTest(f.deps);
    spy();
    await cmdWeb(["restart", "--no-open", "--port", String(port)]);
    expect(process.exitCode ?? 0).toBe(0);
    expect(f.calls).toEqual([
      { target: "gui/501/com.example.acme.web", kill: true },
    ]);
    expect(f.lines).toContainEqual(
      expect.stringMatching(
        /web restarted by its service com\.example\.acme\.web \(pid 31127\)$/,
      ),
    );
    expect(f.lines).toContain("  Log: /Users/x/Library/Logs/acme/web.log");
    expect(logged.join("\n")).not.toMatch(
      /Starting|web started|starting again/,
    );
  });

  it("down is refused, naming service uninstall; launchd is not asked", async () => {
    const port = await freePort();
    const f = fakeLaunchd();
    setWebServiceDepsForTest(f.deps);
    spy();
    await cmdWeb(["down", "--port", String(port)]);
    expect(process.exitCode).toBe(1);
    expect(f.calls).toEqual([]);
    expect(f.lines.join("\n")).toMatch(
      /runs as the service com\.example\.acme\.web \(login\): stopping it only makes launchd start it again[\s\S]*service uninstall/,
    );
    expect(logged.join("\n")).not.toMatch(/web stopped/);
  });

  it("up, not answering: the job is started through launchd", async () => {
    const port = await freePort();
    const f = fakeLaunchd();
    setWebServiceDepsForTest(f.deps);
    spy();
    await cmdWeb(["up", "--no-open", "--port", String(port)]);
    expect(f.calls).toHaveLength(1);
    expect(f.lines).toContainEqual(
      expect.stringMatching(/web started by its service .* \(pid 31127\)$/),
    );
    expect(logged.join("\n")).not.toMatch(/Starting/);
  });

  it("always mode: prints the sudo kickstart, never runs it", async () => {
    const port = await freePort();
    const f = fakeLaunchd("always");
    setWebServiceDepsForTest(f.deps);
    spy();
    await cmdWeb(["restart", "--no-open", "--port", String(port)]);
    expect(process.exitCode).toBe(1);
    expect(f.calls).toEqual([]);
    expect(f.lines).toContain(
      "  sudo launchctl kickstart -k system/com.example.acme.web",
    );
  });
});

describe("webServiceAction", () => {
  const ready = async () => true;
  it("no service, or up while it answers: not handled", async () => {
    expect(
      await webServiceAction("restart", 1, false, ready, {
        service: () => null,
      }),
    ).toEqual({ handled: false });
    const f = fakeLaunchd();
    expect(await webServiceAction("up", 1, true, ready, f.deps)).toEqual({
      handled: false,
    });
    expect(f.calls).toEqual([]);
  });

  it("the job never gets a new pid: fails naming the service log", async () => {
    const f = fakeLaunchd();
    const r = await webServiceAction("restart", 1, true, ready, {
      ...f.deps,
      jobPid: () => 31126,
      pidTimeoutMs: 20,
    });
    expect(r).toEqual({ handled: true, code: 1 });
    expect(f.lines).toContain(
      "✗ the service com.example.acme.web did not come back. See /Users/x/Library/Logs/acme/web.log",
    );
  });

  it("kickstart fails: says so", async () => {
    const f = fakeLaunchd();
    const r = await webServiceAction("restart", 1, true, ready, {
      ...f.deps,
      kickstart: () => 113,
    });
    expect(r).toEqual({ handled: true, code: 1 });
    expect(f.lines[0]).toBe(
      "✗ launchctl kickstart -k gui/501/com.example.acme.web failed (exit 113)",
    );
  });
});
