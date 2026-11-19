/**
 * D18/D20: doctor's "where it runs" rows: the web server's and the session
 * host's launchd session (Aqua ends at logout), and a service whose plist
 * is present but whose job launchd has not loaded (with the bootstrap fix).
 * Every probe is injected: nothing here reaches launchd.
 */
import { describe, expect, it } from "@jest/globals";
import {
  formatWhere,
  serviceJobState,
  whereRows,
  type WhereDeps,
} from "../../../src/ui/cli/doctor-where.js";
import { whereCheck } from "../../../src/ui/cli/doctor-command.js";

const base = (over: Partial<WhereDeps> = {}): WhereDeps => ({
  cli: "acme",
  platform: "darwin",
  server: async () => ({ launchd: "Background" }),
  host: async () => ({ launchd: "Background" }),
  service: () => ({
    state: "loaded",
    mode: "always",
    plist: "/x.plist",
    domain: "system",
  }),
  ...over,
});

describe("whereRows", () => {
  it("says the server and host keep running after logout outside the desktop session", async () => {
    const rows = await whereRows(base());
    expect(rows.map((r) => [r.what, r.session, r.status])).toEqual([
      ["server", "Background", "ok"],
      ["session host", "Background", "ok"],
      ["service", "always (system)", "ok"],
    ]);
  });

  it("warns, with the fix, when the host runs in the desktop session", async () => {
    const rows = await whereRows(
      base({ host: async () => ({ launchd: "Aqua" }) }),
    );
    const host = rows.find((r) => r.what === "session host")!;
    expect(host.status).toBe("warn");
    expect(host.detail).toContain("stops when you log out");
    expect(host.detail).toContain("acme service install --mode always");
  });

  it("login mode as installed: the server's Aqua is ℹ, not ⚠ (it was chosen)", async () => {
    const rows = await whereRows(
      base({
        server: async () => ({ launchd: "Aqua" }),
        host: async () => ({ launchd: "Aqua", pid: 7 }),
        service: () => ({
          state: "loaded",
          mode: "login",
          plist: "/x.plist",
          domain: "gui/501",
        }),
        hostJob: () => 7,
      }),
    );
    expect(rows.map((r) => [r.what, r.status])).toEqual([
      ["server", "info"],
      ["session host", "info"],
      ["service", "ok"],
    ]);
    expect(formatWhere(rows, "Acme").join("\n")).toMatch(/server\s+Aqua\s+ℹ/);
    expect(whereCheck(rows[0]).status).toBe("ok");
  });

  it("no service: Aqua is still ⚠ (nobody chose it)", async () => {
    const rows = await whereRows(
      base({ server: async () => ({ launchd: "Aqua" }), service: () => null }),
    );
    expect(rows[0].status).toBe("warn");
  });

  it("an older host serving, the service's host standing by: ℹ, nothing to do; --stop only as optional", async () => {
    const rows = await whereRows(
      base({
        host: async () => ({
          launchd: null,
          pid: 1776,
          startedAt: "2026-11-09T16:51:29.000Z",
        }),
        hostJob: () => 29946,
      }),
    );
    const h = rows.find((r) => r.what === "session host")!;
    expect(h).toMatchObject({
      session: "older host (pid 1776)",
      status: "info",
    });
    expect(h.detail).toBe(
      "an older session host (pid 1776, since 2026-11-09) is serving; the service's host (pid 29946) takes over when it exits. Nothing to do. To switch now (ends running terminals and agents): acme sessions host --stop",
    );
    expect(whereCheck(h).status).toBe("ok");
    expect(formatWhere(rows, "Acme").join("\n")).not.toMatch(
      /unknown|⚠ an older/,
    );
  });

  it("drill (a): the service has no host job, and a host runs: ⚠ it won't come back after a restart, with the fix", async () => {
    const rows = await whereRows(
      base({
        host: async () => ({ launchd: "Aqua", pid: 2240 }),
        hostJob: () => null,
        hostJobInstalled: () => false,
      }),
    );
    const h = rows.find((r) => r.what === "session host")!;
    expect(h.status).toBe("warn");
    expect(h.detail).toBe(
      "The service runs only the web part here: it has no host job, so the host running now (pid 2240) was started outside it and won't come back by itself after a restart. Its terminals and agents end then. Fix: acme service install (it adds the host job; nothing running stops).",
    );
    expect(whereCheck(h).status).toBe("warn");
  });

  it("drill (a): no warning when the host job is there, or there's no service at all", async () => {
    for (const over of [
      { hostJobInstalled: () => true },
      { hostJobInstalled: () => false, service: () => null },
    ]) {
      const rows = await whereRows(
        base({
          host: async () => ({ launchd: "Background", pid: 7 }),
          ...over,
        }),
      );
      const h = rows.find((r) => r.what === "session host")!;
      expect(h.detail ?? "").not.toContain("won't come back");
    }
  });

  it("an older host with no service host behind it: ℹ, from before this version, nothing to do", async () => {
    const rows = await whereRows(
      base({
        host: async () => ({ launchd: null, pid: 1776 }),
        hostJob: () => null,
      }),
    );
    const h = rows.find((r) => r.what === "session host")!;
    expect(h.status).toBe("info");
    expect(h.session).toBe("older host (pid 1776)");
    expect(h.detail).toMatch(
      /^an older session host \(pid 1776\) is serving, from before this version.*picks up this version the next time it exits\. Nothing to do\./,
    );
    expect(h.session).not.toMatch(/unknown/);
  });

  it("Full Disk Access granted to Den's node copy", async () => {
    const rows = await whereRows(
      base({
        host: async () => ({
          launchd: "System",
          access: {
            exe: "/home/u/.acme/bin/acme-sessions-host",
            fullDiskAccess: true,
          },
        }),
      }),
    );
    expect(rows.find((r) => r.what === "full disk access")).toEqual({
      what: "full disk access",
      session: "granted",
      status: "ok",
      detail: "to /home/u/.acme/bin/acme-sessions-host",
    });
  });

  it("not granted: names the copy to grant, never the shared node", async () => {
    const own = await whereRows(
      base({
        host: async () => ({
          launchd: "System",
          access: {
            exe: "/home/u/.acme/bin/acme-sessions-host",
            fullDiskAccess: false,
          },
        }),
      }),
    );
    const row = own.find((r) => r.what === "full disk access")!;
    expect(row.status).toBe("warn");
    expect(row.detail).toContain(
      "Full Disk Access → + → /home/u/.acme/bin/acme-sessions-host",
    );
    const shared = await whereRows(
      base({
        host: async () => ({
          launchd: "Aqua",
          access: {
            exe: "/home/u/.nvm/versions/node/v24.13.0/bin/node",
            fullDiskAccess: false,
          },
        }),
      }),
    );
    const s2 = shared.find((r) => r.what === "full disk access")!;
    expect(s2.detail).toContain("acme service install gives it its own copy");
    expect(s2.detail).not.toContain("+ → /home/u/.nvm");
  });

  it("can't tell (an older host, off macOS): no row", async () => {
    const rows = await whereRows(
      base({ host: async () => ({ launchd: "System", access: null }) }),
    );
    expect(rows.find((r) => r.what === "full disk access")).toBeUndefined();
  });

  it("a host not running is not a problem: it starts on demand", async () => {
    const rows = await whereRows(base({ host: async () => null }));
    expect(rows.find((r) => r.what === "session host")).toMatchObject({
      session: "not running",
      status: "ok",
    });
  });

  it("a server not running says how to start it, without a warning", async () => {
    const rows = await whereRows(base({ server: async () => null }));
    expect(rows.find((r) => r.what === "server")).toMatchObject({
      session: "not running",
      status: "ok",
      detail: "start it: acme web up, or acme service install",
    });
  });

  it("plist present, job not loaded: names the bootstrap fix", async () => {
    const rows = await whereRows(
      base({
        service: () => ({
          state: "not-loaded",
          mode: "login",
          plist: "/Users/someone/Library/LaunchAgents/local.acme.web.plist",
          domain: "gui/501",
        }),
      }),
    );
    const svc = rows.find((r) => r.what === "service")!;
    expect(svc.status).toBe("warn");
    expect(svc.detail).toBe(
      "plist present, job not loaded: launchctl bootstrap gui/501 /Users/someone/Library/LaunchAgents/local.acme.web.plist",
    );
  });

  it("a LaunchDaemon's bootstrap fix needs sudo", async () => {
    const rows = await whereRows(
      base({
        service: () => ({
          state: "not-loaded",
          mode: "always",
          plist: "/Library/LaunchDaemons/local.acme.web.plist",
          domain: "system",
        }),
      }),
    );
    expect(rows.find((r) => r.what === "service")!.detail).toBe(
      "plist present, job not loaded: sudo launchctl bootstrap system /Library/LaunchDaemons/local.acme.web.plist",
    );
  });

  it("an always service: the where-line says agents sign in with the token (the sign-in row warns, not this one)", async () => {
    const rows = await whereRows(base());
    expect(rows.find((r) => r.what === "service")).toMatchObject({
      session: "always (system)",
      status: "ok",
      detail:
        "agents keep running after logout; they sign in with the long-lived token, not the login keychain (see agent sign-in)",
    });
    const login = await whereRows(
      base({
        service: () => ({
          state: "loaded",
          mode: "login",
          plist: "/x.plist",
          domain: "gui/501",
        }),
      }),
    );
    expect(login.find((r) => r.what === "service")!.detail).toBeUndefined();
  });

  it("no service installed: says how", async () => {
    const rows = await whereRows(base({ service: () => null }));
    expect(rows.find((r) => r.what === "service")).toMatchObject({
      session: "not installed",
      status: "ok",
      detail:
        "acme service install (always, the default for a new install: agents keep running after logout, one sudo; agents sign in there with a long-lived token from your secrets store (agents token set); --mode login stops them at logout)",
    });
  });

  it("off macOS: no rows", async () => {
    expect(await whereRows(base({ platform: "linux" }))).toEqual([]);
  });
});

describe("serviceJobState", () => {
  const exists = (paths: string[]) => (p: string) => paths.includes(p);
  const daemon = "/Library/LaunchDaemons/local.acme.web.plist";
  const agent = "/home/u/Library/LaunchAgents/local.acme.web.plist";

  it("prefers the LaunchDaemon (always) over the LaunchAgent (login)", () => {
    const s = serviceJobState("local.acme.web", "/home/u", 501, {
      exists: exists([daemon, agent]),
      print: () => 0,
    });
    expect(s).toEqual({
      state: "loaded",
      mode: "always",
      plist: daemon,
      domain: "system",
    });
  });

  it("a LaunchAgent launchd doesn't know is not loaded", () => {
    expect(
      serviceJobState("local.acme.web", "/home/u", 501, {
        exists: exists([agent]),
        print: () => 113,
      }),
    ).toEqual({
      state: "not-loaded",
      mode: "login",
      plist: agent,
      domain: "gui/501",
    });
  });

  it("launchctl missing (127) is unknown, never 'not loaded'", () => {
    expect(
      serviceJobState("local.acme.web", "/home/u", 501, {
        exists: exists([agent]),
        print: () => 127,
      })?.state,
    ).toBe("unknown");
  });

  it("no plist: null", () => {
    expect(
      serviceJobState("local.acme.web", "/home/u", 501, {
        exists: () => false,
        print: () => 0,
      }),
    ).toBeNull();
  });
});

/**
 * Issue 163: one row that answers "does this install survive a logout?",
 * yes or no, with why and the fix in words. An install from before
 * keep-running was the default stays in login mode after an update: the
 * row says so plainly, and the fix is Den's own Apply (one admin
 * password), not a terminal chore.
 */
describe("survives logout", () => {
  const logout = async (over: Partial<WhereDeps> = {}) =>
    (await whereRows(base(over))).find((r) => r.what === "survives logout");
  const login = (state: "loaded" | "not-loaded" = "loaded") => () => ({
    state,
    mode: "login" as const,
    plist: "/x.plist",
    domain: "gui/501",
  });

  it("always, loaded, host and server outside the desktop login: yes", async () => {
    expect(await logout()).toMatchObject({
      session: "yes",
      status: "ok",
      detail:
        "agents keep running when you log out, and are still running when you log back in",
    });
    // No host yet: it starts under the service, so still yes.
    expect((await logout({ host: async () => null }))!.session).toBe("yes");
  });

  it("login mode (an install from before the default, Setting unset): no, with Den's Apply as the fix", async () => {
    const row = await logout({
      server: async () => ({ launchd: "Aqua" }),
      host: async () => ({ launchd: "Aqua", pid: 7 }),
      service: login(),
      keepSetting: () => undefined,
    });
    expect(row).toMatchObject({ session: "no (login mode)", status: "warn" });
    expect(row!.detail).toContain(
      "this install stops its agents at logout (login mode)",
    );
    expect(row!.detail).toContain(
      "Settings › Agents › Keep agents running after logout › Apply",
    );
    expect(row!.detail).toContain("one admin password");
    // The fix is Den's, not a terminal line.
    expect(row!.detail).not.toContain("acme service install");
    expect(row!.detail).not.toContain("acme config");
  });

  it("login mode because the person turned it off: no, as chosen (ℹ)", async () => {
    const row = await logout({
      server: async () => ({ launchd: "Aqua" }),
      service: login(),
      keepSetting: () => false,
    });
    expect(row).toMatchObject({ session: "no (turned off)", status: "info" });
    expect(row!.detail).toContain(
      "Keep agents running after logout is off (Settings › Agents)",
    );
  });

  it("always, but the host serving now runs in the desktop login: no", async () => {
    const row = await logout({ host: async () => ({ launchd: "Aqua", pid: 9 }) });
    expect(row).toMatchObject({
      session: "no (host in the desktop login)",
      status: "warn",
    });
    expect(row!.detail).toContain("pid 9");
  });

  it("the job isn't loaded, or there is no service: no", async () => {
    expect(
      await logout({
        service: () => ({
          state: "not-loaded",
          mode: "always",
          plist: "/x.plist",
          domain: "system",
        }),
      }),
    ).toMatchObject({ session: "no (job not loaded)", status: "warn" });
    const none = await logout({
      service: () => null,
      server: async () => ({ launchd: "Aqua" }),
    });
    expect(none).toMatchObject({ session: "no (no service)", status: "warn" });
    expect(none!.detail).toContain("this install stops its agents at logout");
  });
});
