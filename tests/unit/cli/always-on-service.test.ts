/**
 * Issue 163 (a), (b), (c): the always-on service, proved without a logout.
 *
 *   - install.sh under mode always writes both LaunchDaemons with
 *     DEN_AGENT_SIGNIN=token (agents sign in with the store's token) and
 *     never a token value; login writes neither.
 *   - On by default: a new install (no job yet, the Setting unset) installs
 *     mode always; an explicit false is kept; an existing install with the
 *     Setting unset keeps its mode (it needs sudo) and is offered Apply
 *     once, in the bell and in doctor.
 *   - doctor says when always-on is set but no token is configured, and
 *     when it was set.
 *   - `agents token set` reads the token from stdin or a prompt, never
 *     argv; a person's only; nothing printed carries it.
 *
 * launchctl and sudo are shims on PATH in temp dirs: nothing reaches this
 * machine's launchd, root, keychain or secrets store. Invented values only.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { cmdService } from "../../../src/ui/cli/service-command.js";
import { whereRows, type WhereDeps } from "../../../src/ui/cli/doctor-where.js";
import { noteKeepRunningOffer } from "../../../src/ui/server/keep-running-routes.js";
import {
  bellPrefs,
  bellView,
  type Notification,
} from "../../../src/shared/notifications.js";
import { cmdAgents } from "../../../src/ui/cli/agents-command.js";
import type { TokenStatus } from "../../../src/shared/agents/signin-token.js";

const root = path.resolve(__dirname, "../../..");
const script = path.join(root, "service", "install.sh");
const dist = path.join(root, "examples", "distribution");
const TOKEN = "fake-oat-token-0123456789abcdef";
const tmps: string[] = [];
afterEach(() => {
  for (const d of tmps.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});
const tmp = (p: string) => {
  const t = fs.mkdtempSync(path.join(os.tmpdir(), p));
  tmps.push(t);
  return t;
};
const mac = process.platform === "darwin" ? it : it.skip;

/** install.sh with launchctl and sudo shims on PATH (service-modes' rig). */
function shimRig() {
  const t = tmp("den-always-on-");
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
    `echo "sudo $*" >> "${calls}"\nif [ "$1" = install ]; then shift; while [ "$1" = -o ] || [ "$1" = -g ]; do shift 2; done; exec install "$@"; fi\nexec "$@"`,
  );
  shim(
    "codesign",
    `echo "designated => identifier node and certificate leaf[subject.OU] = TEAM1"`,
  );
  shim("otool", `echo "$2:"`);
  // A `security` that records any run: the keychain is never asked.
  shim("security", `echo "security $*" >> "${calls}"\nexit 1`);
  const node = path.join(t, "node-a");
  fs.writeFileSync(node, "#!/bin/sh\necho 22\n", { mode: 0o755 });
  const home = path.join(t, "home");
  fs.mkdirSync(home);
  const daemons = path.join(t, "LaunchDaemons");
  fs.mkdirSync(daemons);
  return {
    t,
    home,
    daemons,
    calls,
    env: {
      PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
      HOME: home,
      DEN_ROOT: dist,
      DEN_SERVICE_LABEL: "local.acme-on.web",
      DEN_SERVICE_LOGS: path.join(t, "logs"),
      DEN_SERVICE_NODE: node,
      DEN_SERVICE_HOST_EXE: path.join(t, "state", "bin", "acme-sessions-host"),
      DEN_SERVICE_DAEMON_DIR: daemons,
      DEN_SERVICE_SUDO: path.join(bin, "fakesudo"),
      DEN_SERVICE_READY_CHECK: "external",
      // Even with a token in the installer's env, no plist carries it.
      CLAUDE_CODE_OAUTH_TOKEN: TOKEN,
    } as Record<string, string>,
  };
}

const envVar = (xml: string, key: string) =>
  new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`).exec(xml)?.[1];

describe("the always-on jobs' plists carry the token sign-in, never a token", () => {
  it.each(["print", "print-host"])(
    "%s: always carries DEN_AGENT_SIGNIN=token; login doesn't",
    (which) => {
      const r = shimRig();
      const run = (mode: string) =>
        spawnSync("bash", [script, which], {
          encoding: "utf-8",
          env: { ...r.env, DEN_SERVICE_MODE: mode },
        });
      const always = run("always");
      expect(always.status).toBe(0);
      expect(envVar(always.stdout, "DEN_AGENT_SIGNIN")).toBe("token");
      expect(always.stdout).not.toContain(TOKEN);
      expect(always.stdout).not.toContain("CLAUDE_CODE_OAUTH_TOKEN");
      const login = run("login");
      expect(login.status).toBe(0);
      expect(login.stdout).not.toContain("DEN_AGENT_SIGNIN");
    },
  );

  mac(
    "install --mode always through the sudo and launchctl shims: both daemons carry it, the keychain is never asked",
    () => {
      const r = shimRig();
      const out = spawnSync("bash", [script, "install"], {
        encoding: "utf-8",
        env: { ...r.env, DEN_SERVICE_MODE: "always" },
      });
      expect(out.status).toBe(0);
      for (const label of ["local.acme-on.web", "local.acme-on.sessions"]) {
        const xml = fs.readFileSync(
          path.join(r.daemons, `${label}.plist`),
          "utf-8",
        );
        expect(envVar(xml, "DEN_AGENT_SIGNIN")).toBe("token");
        expect(xml).not.toContain(TOKEN);
      }
      const calls = fs.readFileSync(r.calls, "utf-8");
      expect(calls).not.toContain(TOKEN);
      expect(calls).not.toMatch(/^security /m);
    },
  );
});

describe("on by default (a)", () => {
  /** cmdService install --plan with a recording runner: the mode it picks. */
  async function modeFor(
    installed: "login" | "always" | null,
    keep: boolean | undefined,
  ): Promise<string> {
    const envs: Record<string, string>[] = [];
    const lines: string[] = [];
    await cmdService(["install", "--plan"], {
      run: (_c, _a, env) => {
        envs.push(env);
        return 0;
      },
      job: () =>
        installed
          ? {
              state: "loaded",
              mode: installed,
              plist: "/x.plist",
              domain: installed === "always" ? "system" : "gui/501",
            }
          : null,
      keepRunning: () => keep,
      stateDir: tmp("den-on-state-"),
      config: { name: "acme" } as never,
      distRoot: dist,
      engineRoot: root,
      home: tmp("den-on-home-"),
      platform: "darwin",
      webPort: 1,
      identify: async () => ({ kind: "none" }),
      log: (l) => lines.push(l),
    });
    return envs[0]!.DEN_SERVICE_MODE!;
  }

  it("a new install (no job, the Setting unset) installs mode always", async () => {
    expect(await modeFor(null, undefined)).toBe("always");
  });
  it("an explicit false is kept", async () => {
    expect(await modeFor(null, false)).toBe("login");
    expect(await modeFor("always", false)).toBe("login");
  });
  it("an existing login install with the Setting unset is not switched (it needs sudo)", async () => {
    expect(await modeFor("login", undefined)).toBe("login");
  });
  it("on is always", async () => {
    expect(await modeFor("login", true)).toBe("always");
  });
});

describe("the one-time offer for an existing install (a)", () => {
  const store = () => {
    const added: { subject: string; msg?: { key: string } }[] = [];
    return { added, add: (n: never) => void added.push(n) };
  };

  it("login install, Setting unset: one bell note, once", () => {
    const s = store();
    const dir = tmp("den-offer-");
    const d = { installed: () => "login" as const, keep: () => undefined };
    expect(noteKeepRunningOffer(s, dir, d)).toBe(true);
    expect(noteKeepRunningOffer(s, dir, d)).toBe(false);
    expect(s.added).toHaveLength(1);
    expect(s.added[0]!.msg?.key).toBe("bell.m.keepOffer");
  });

  // Issue 163: an offer the person must act on is in "needs you": counted
  // on the badge, never folded under Updates.
  it("needs you: on the badge, not folded under Updates", () => {
    const added: Omit<Notification, "id" | "source" | "at" | "read">[] = [];
    noteKeepRunningOffer(
      { add: (n) => void added.push(n as never) },
      tmp("den-offer-"),
      { installed: () => "login", keep: () => undefined },
    );
    expect(added).toHaveLength(1);
    const item = {
      ...added[0]!,
      id: "n1",
      source: "den",
      at: new Date().toISOString(),
      read: false,
    } as Notification;
    const view = bellView([item], bellPrefs({}));
    expect(view.unread).toBe(1);
    expect(view.recent.map((n) => n.id)).toEqual(["n1"]);
    expect(view.updates).toEqual([]);
  });

  it.each([
    ["the Setting set off", "login", false],
    ["the Setting set on", "login", true],
    ["already always", "always", undefined],
    ["not a service", null, undefined],
  ] as const)("none when %s", (_w, installed, keep) => {
    const s = store();
    expect(
      noteKeepRunningOffer(s, tmp("den-offer-"), {
        installed: () => installed,
        keep: () => keep,
      }),
    ).toBe(false);
    expect(s.added).toHaveLength(0);
  });
});

describe("doctor (a), (b)", () => {
  const deps = (over: Partial<WhereDeps>): WhereDeps => ({
    cli: "acme",
    platform: "darwin",
    server: async () => ({ launchd: "System" }),
    host: async () => ({ launchd: "System", pid: 5 }),
    service: () => ({
      state: "loaded",
      mode: "always",
      plist: "/Library/LaunchDaemons/x.plist",
      domain: "system",
    }),
    ...over,
  });
  const st = (over: Partial<TokenStatus>): TokenStatus => ({
    mode: "token",
    configured: true,
    setAt: "2026-11-01T10:00:00Z",
    ageDays: 15,
    old: false,
    warnDays: 330,
    store: "1Password",
    stored: true,
    ...over,
  });

  it("always-on with no token configured: agents will not be able to sign in after logout", async () => {
    const rows = await whereRows(
      deps({ signIn: async () => st({ configured: false, stored: false }) }),
    );
    const row = rows.find((r) => r.what === "agent sign-in")!;
    expect(row.status).toBe("warn");
    expect(row.detail).toMatch(
      /no sign-in token is configured: agents will not be able to sign in after logout.*acme agents token set/,
    );
  });

  it("always-on with a token: says when it was set", async () => {
    const rows = await whereRows(deps({ signIn: async () => st({}) }));
    const row = rows.find((r) => r.what === "agent sign-in")!;
    expect(row.status).toBe("ok");
    expect(row.detail).toMatch(/token set .*2026/);
  });

  it("login mode: no sign-in row; with the Setting unset, the offer", async () => {
    const login = () => ({
      state: "loaded" as const,
      mode: "login" as const,
      plist: "/x.plist",
      domain: "gui/501",
    });
    const rows = await whereRows(
      deps({
        service: login,
        signIn: async () => st({ mode: "desktop" }),
        keepSetting: () => undefined,
      }),
    );
    expect(rows.find((r) => r.what === "agent sign-in")).toBeUndefined();
    const offer = rows.find((r) => r.what === "keep running")!;
    expect(offer.status).toBe("info");
    expect(offer.detail).toMatch(
      /Keep agents running after logout.*Apply.*acme config agents\.keep_running_after_logout=true/,
    );
    const off = await whereRows(
      deps({ service: login, keepSetting: () => false }),
    );
    expect(off.find((r) => r.what === "keep running")).toBeUndefined();
  });
});

describe("agents token set (b)", () => {
  const run = async (
    args: string[],
    over: {
      input?: string;
      env?: Record<string, string>;
    } = {},
  ) => {
    const out: string[] = [];
    const err: string[] = [];
    const saved: string[] = [];
    const code = await cmdAgents(["token", ...args], {
      dist: "acme",
      cli: "acme",
      env: over.env ?? { PATH: "/usr/bin:/bin" },
      stateDir: () => tmp("den-token-state-"),
      tokenInput: async () => over.input ?? "",
      tokenSave: async (t) => {
        saved.push(t);
        return { ref: "configured", store: "1Password" };
      },
      out: (l) => out.push(l),
      err: (l) => err.push(l),
    });
    return { code, out, err, saved };
  };

  it("reads the token from stdin or a prompt and writes it to the store; prints only where", async () => {
    const r = await run(["set"], { input: `${TOKEN}\n` });
    expect(r.code).toBe(0);
    expect(r.saved).toEqual([TOKEN]);
    expect(r.out.join("\n")).toMatch(/saved in 1Password/);
    expect([...r.out, ...r.err].join("\n")).not.toContain(TOKEN);
  });

  it("never from argv: a value after set is refused, and nothing is saved", async () => {
    const r = await run(["set", TOKEN], { input: TOKEN });
    expect(r.code).toBe(2);
    expect(r.saved).toEqual([]);
    expect(r.err.join("\n")).toMatch(/never on the command line/);
    // Not even the refused value is echoed.
    expect(r.err.join("\n")).not.toContain(TOKEN);
  });

  it("a person's only: refused inside an agent's session", async () => {
    const r = await run(["set"], {
      input: TOKEN,
      env: { PATH: "/usr/bin", DEN_ACTOR_TOKEN_FILE: "/x/token" },
    });
    expect(r.code).toBe(1);
    expect(r.saved).toEqual([]);
    expect(r.err.join("\n")).toMatch(/only a person/);
  });

  it("an empty input is refused, naming how to make one", async () => {
    const r = await run(["set"], { input: "  \n" });
    expect(r.code).toBe(1);
    expect(r.err.join("\n")).toMatch(/no token given.*claude setup-token/);
  });
});

describe("doctor: the store's credential in the login keychain (b)", () => {
  it("under always, the sign-in row warns with the fix", async () => {
    const rows = await whereRows({
      cli: "acme",
      platform: "darwin",
      server: async () => ({ launchd: "System" }),
      host: async () => ({ launchd: "System", pid: 5 }),
      service: () => ({
        state: "loaded",
        mode: "always",
        plist: "/Library/LaunchDaemons/x.plist",
        domain: "system",
      }),
      signIn: async () => ({
        mode: "token",
        configured: true,
        setAt: "2026-11-01T10:00:00Z",
        ageDays: 15,
        old: false,
        warnDays: 330,
        store: "1Password",
        stored: true,
        credInKeychain: true,
      }),
    });
    const row = rows.find((r) => r.what === "agent sign-in")!;
    expect(row.status).toBe("warn");
    expect(row.detail).toContain(
      "the store's credential is in the login keychain, which the always-on service may not reach; use file: or env: (see docs/always-on-gate.md)",
    );
  });
});
