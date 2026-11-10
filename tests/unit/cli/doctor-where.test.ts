/**
 * D18/D20: doctor's "where it runs" rows: the web server's and the session
 * host's launchd session (Aqua ends at logout), and a service whose plist
 * is present but whose job launchd has not loaded (with the bootstrap fix).
 * Every probe is injected: nothing here reaches launchd.
 */
import { describe, expect, it } from "@jest/globals";
import {
  serviceJobState,
  whereRows,
  type WhereDeps,
} from "../../../src/ui/cli/doctor-where.js";

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

  it("an always service: ok, but not yet proven across a logout", async () => {
    const rows = await whereRows(base());
    expect(rows.find((r) => r.what === "service")).toMatchObject({
      session: "always (system)",
      status: "ok",
      detail: "opt-in: not yet proven across a logout",
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
        "acme service install (login, the default; --mode always is opt-in and not yet proven across a logout)",
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
