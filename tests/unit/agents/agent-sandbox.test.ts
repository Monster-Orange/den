/**
 * Issue 936, slice 1: Den's state is read-only to an agent's session.
 *
 * The session starts under the OS sandbox (sandbox-exec on macOS, bwrap on
 * Linux). Inside it:
 *   - Den's state dir and the install's config/local (user.yml) can't be
 *     written: not its own record (its mode), not the settings file; nor
 *     the gate store's settings (its slot queue stays writable: `gate run`
 *     and the MCP slot tools write it from the session until issue 621);
 *   - Den's own private files and other agents' files can't be read;
 *   - the session host's socket can't be reached (a session started there
 *     would run outside the sandbox);
 *   - its own agent-files folder stays writable (handoff.md, its notes,
 *     the hooks' counts), except the launch files Den writes there.
 *
 * The real-sandbox tests run the OS's tool on a temporary state dir; they
 * skip where the tool is missing (a Linux box without bwrap).
 */
import { afterAll, describe, expect, it } from "@jest/globals";
import { spawn, spawnSync } from "child_process";
import * as fs from "fs";
import * as net from "net";
import * as os from "os";
import * as path from "path";
import {
  AGENT_SANDBOX_ENV,
  LAUNCH_FILES,
  agentSandboxPolicy,
  bwrapArgs,
  macProfile,
  realPath,
  SESSION_READ_DIRS,
  bwrapStarts,
  SESSION_READ_FILES,
  localProofDirs,
  sandboxErrorHint,
  sandboxFor,
  sandboxSetting,
} from "../../../src/shared/agents/sandbox.js";
import {
  cmdAgents,
  sandboxLines,
  type SandboxReport,
} from "../../../src/ui/cli/agents-command.js";
import { agentSandboxInput } from "../../../src/ui/cli/agent-ops.js";
import { cleanupRigs, rig } from "./helpers/rig.js";
import { readAuditRows } from "../../../src/shared/audit-queue.js";
import {
  readAgentsConfig,
  type DenConfig,
  type UserConfig,
} from "../../../src/shared/den-config.js";

// Short: a unix socket's path is at most 103 bytes (macOS).
const tmp = fs.realpathSync(
  fs.mkdtempSync(
    path.join(process.platform === "win32" ? os.tmpdir() : "/tmp", "dsb-"),
  ),
);
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
afterAll(cleanupRigs);

/**
 * Den's private files in the state dir that no session reads: each must
 * stay unreadable (the real-sandbox test reads every one).
 */
const KNOWN_PRIVATE = [
  "push-vapid.json",
  "fixture-person.key",
  "claim-nonces.json",
  "agent-signin-accounts.json",
  path.join("hub", "unrevoked", "x.token"),
  path.join("hub", "previous", "20261122", "bound.json"),
  path.join("embed", "server-keys.json"),
  "web-sessions.json",
  path.join("backup", "actor-tokens.json.2026-11-23T08-00-00-000Z.bad"),
];

function layout(name: string) {
  const base = path.join(tmp, name);
  const stateDir = path.join(base, "state");
  const distRoot = path.join(base, "root");
  const gateDir = path.join(base, "gate-slots");
  const own = path.join(stateDir, "agent-files", "a1");
  for (const d of [
    path.join(stateDir, "agents"),
    path.join(stateDir, "hub"),
    path.join(stateDir, "gate"),
    path.join(stateDir, "actor-token", "a1"),
    path.join(stateDir, "actor-token", "a2"),
    own,
    path.join(distRoot, "config", "local"),
    path.join(gateDir, "slots"),
    path.join(base, "work"),
  ])
    fs.mkdirSync(d, { recursive: true });
  const put = (f: string, s = "x\n") => fs.writeFileSync(f, s);
  put(path.join(stateDir, "agents", "a1.json"), '{"mode":"permission"}\n');
  put(path.join(stateDir, "web.secret"), "person-secret\n");
  put(path.join(stateDir, "web-sessions.json"), "{}\n");
  put(path.join(stateDir, "hub", "token"), "hub-token\n");
  put(path.join(stateDir, "gate", "runner-tokens.json"), "{}\n");
  put(path.join(stateDir, "actor-token", "a1", "token"), "own-token\n");
  put(path.join(stateDir, "actor-token", "a2", "token"), "other-token\n");
  put(path.join(distRoot, "config", "local", "user.yml"), "local_dev: true\n");
  put(path.join(gateDir, "settings.json"), "{}\n");
  for (const f of LAUNCH_FILES) put(path.join(own, f), "{}\n");
  // Den's other private files in the state dir (none on any read list).
  for (const f of KNOWN_PRIVATE) {
    fs.mkdirSync(path.dirname(path.join(stateDir, f)), { recursive: true });
    put(path.join(stateDir, f), "private\n");
  }
  put(path.join(stateDir, "web.json"), '{"port":1}\n');
  const proof = path.join(base, "app", "den", "local-proof");
  fs.mkdirSync(proof, { recursive: true });
  put(path.join(proof, "k"), "proof\n");
  return {
    base,
    stateDir,
    distRoot,
    gateDir,
    own,
    agentId: "a1",
    deniedDirs: [proof],
    proof,
  };
}

describe("agentSandboxPolicy (issue 936)", () => {
  it("issue 1391: a personal install's trail is read back inside the state dir, and never written", () => {
    const l = layout("trail");
    const p = agentSandboxPolicy({ ...l, trailReadable: true });
    const trail = path.join(l.stateDir, "audit.jsonl");
    expect(p.readableFiles).toContain(trail);
    expect(
      p.writable.some((w) => trail === w || trail.startsWith(w + path.sep)),
    ).toBe(false);
  });

  it("makes the state dir, config/local and the denied folders read-only", () => {
    const l = layout("policy");
    const p = agentSandboxPolicy(l);
    expect(p.readOnly).toEqual([
      l.stateDir,
      path.join(l.distRoot, "config", "local"),
      l.proof,
    ]);
  });

  it("leaves its own folder and the slot queue writable, launch files and gate settings locked", () => {
    const l = layout("policy-own");
    const p = agentSandboxPolicy(l);
    // And the api_only guardrail's audit folder (its hook writes there).
    expect(p.writable).toEqual([
      l.own,
      l.gateDir,
      path.join(l.stateDir, "audit"),
    ]);
    for (const f of ["settings.json", "mcp.json", "compacting.json"])
      expect(p.locked).toContain(path.join(l.own, f));
    expect(p.locked).toContain(path.join(l.gateDir, "settings.json"));
  });

  it("refuses moving a writable folder, or one above it, on macOS", () => {
    const l = layout("policy-rename");
    const prof = macProfile(agentSandboxPolicy(l));
    const guard = prof
      .split("\n")
      .filter((x) => x.startsWith("(deny file-write*"))
      .join(" ");
    for (const d of [l.gateDir, path.dirname(l.gateDir), l.own])
      expect(guard).toContain(`(literal "${d}")`);
    // Guards come after the allows, so they win.
    const at = (s: string) => prof.indexOf(s);
    expect(at(`(literal "${l.gateDir}")`)).toBeGreaterThan(
      at("(allow file-write*"),
    );
  });

  it("refuses Apple Events and LaunchServices opens, on macOS", () => {
    const prof = macProfile(agentSandboxPolicy(layout("policy-ls")));
    expect(prof).toContain("(deny lsopen)");
    expect(prof).toContain("(deny appleevent-send)");
  });

  it("on Linux, masks the container engines' sockets that exist", () => {
    const l = layout("bwrap-docker");
    const socks = [
      "/run/docker.sock",
      "/var/run/docker.sock",
      "/run/containerd/containerd.sock",
      "/run/podman/podman.sock",
    ];
    const a = bwrapArgs(
      agentSandboxPolicy(l),
      (f) => socks.includes(f) || fs.existsSync(f),
      (f) => f,
    ).join(" ");
    for (const s of socks) expect(a).toContain(`--ro-bind /dev/null ${s}`);
    expect(
      bwrapArgs(agentSandboxPolicy(l), fs.existsSync, (f) => f).join(" "),
    ).not.toContain("/run/podman/podman.sock");
  });

  it("checks bwrap with the flags a session uses", () => {
    const seen: string[][] = [];
    const why = bwrapStarts("/x/bwrap", (exe, args) => {
      seen.push([exe, ...args]);
      return { status: 0 };
    });
    expect(why).toBeNull();
    expect(seen[0]).toEqual([
      "/x/bwrap",
      "--ro-bind",
      "/",
      "/",
      "--unshare-pid",
      "--proc",
      "/proc",
      "--die-with-parent",
      "true",
    ]);
  });

  it("refuses every unix socket but the allowed folders, on macOS", () => {
    const l = layout("policy-socks");
    const prof = macProfile(
      agentSandboxPolicy({ ...l, socketsAllowed: ["/var/ok"] }),
    );
    expect(prof).toContain("(deny network-outbound (remote unix-socket))");
    expect(prof).toContain(
      `(remote unix-socket (path-regex #"^${realPath("/var/ok")}(/|$)"))`,
    );
  });

  it("can't read the state dir, but what it names; nor the denied folders", () => {
    const l = layout("policy-read");
    const p = agentSandboxPolicy(l);
    expect(p.unreadable).toEqual([l.stateDir, l.proof]);
    expect(p.readable).toEqual(
      expect.arrayContaining([
        l.own,
        path.join(l.stateDir, "actor-token", "a1"),
        path.join(l.stateDir, "agents"),
      ]),
    );
    expect(p.readable).not.toContain(path.join(l.stateDir, "actor-token"));
    expect(p.readable).not.toContain(path.join(l.stateDir, "hub"));
    expect(p.hidden).toEqual(
      expect.arrayContaining([
        path.join(l.stateDir, "web.secret"),
        path.join(l.stateDir, "hub", "token"),
      ]),
    );
    expect(p.sockets).toEqual([path.join(l.stateDir, "sessions.sock")]);
  });

  it("reads back only what was reviewed: a new entry fails this until it is", () => {
    // Each holds no secret (checked by its keys): bookkeeping, hashes,
    // the web server's port. A name like a secret's needs its line here.
    const reviewed: Record<string, string> = {
      "actor-tokens.json": "sha256 of each token, with what it proves",
      "sessions-host-job.json": "the host job's label and mode",
      "address-proof.json": "whether the address was proven, and when",
    };
    const secretish =
      /token|secret|key|seal|session|vapid|claim|account|proof|passw/i;
    for (const f of [...SESSION_READ_FILES, ...SESSION_READ_DIRS])
      if (secretish.test(f))
        expect([f, reviewed[f]]).toEqual([f, expect.any(String)]);
    for (const f of KNOWN_PRIVATE) {
      expect(SESSION_READ_FILES).not.toContain(f);
      expect(SESSION_READ_DIRS.some((d) => f.startsWith(d + path.sep))).toBe(
        false,
      );
    }
  });

  it("refuses an agent id that would name a path", () => {
    const l = layout("policy-id");
    expect(() => agentSandboxPolicy({ ...l, agentId: "../a2" })).toThrow(
      /agent id/,
    );
  });
});

describe("macProfile and bwrapArgs (issue 936)", () => {
  it("quotes every path, so a quote in a path can't end the rule", () => {
    const l = layout('q"uote');
    const prof = macProfile(agentSandboxPolicy(l));
    expect(prof).toContain('q\\"uote');
    expect(prof).not.toMatch(/q"uote/);
  });

  it("gives bwrap its own pid namespace and /proc, ending with the session", () => {
    const a = bwrapArgs(agentSandboxPolicy(layout("bwrap-pid")));
    expect(a.slice(0, 7)).toEqual([
      "--dev-bind",
      "/",
      "/",
      "--unshare-pid",
      "--proc",
      "/proc",
      "--die-with-parent",
    ]);
  });

  it("covers the state dir with an empty tmpfs, binds back what it reads, read-only", () => {
    const l = layout("bwrap");
    const a = bwrapArgs(agentSandboxPolicy(l));
    const pairs = a.join(" ");
    expect(pairs).toContain(`--tmpfs ${l.stateDir}`);
    expect(pairs).toContain(`--tmpfs ${l.proof}`);
    const web = path.join(l.stateDir, "web.json");
    expect(pairs).toContain(`--ro-bind ${web} ${web}`);
    expect(pairs).toContain(`--bind ${l.own} ${l.own}`);
    expect(pairs).toContain(
      `--ro-bind ${path.join(l.own, "settings.json")} ${path.join(l.own, "settings.json")}`,
    );
    // Nothing private is bound back; the tmpfs hides it.
    expect(pairs).not.toContain("web.secret");
    expect(pairs).not.toContain(path.join("actor-token", "a2"));
    // Order: the tmpfs first, then what it reads, then read-only again.
    expect(a.indexOf(l.own)).toBeGreaterThan(a.indexOf(l.stateDir));
    expect(a.lastIndexOf("--remount-ro")).toBeGreaterThan(a.indexOf(l.own));
    expect(a[a.length - 1]).toBe("--");
  });

  it("pins the folders above the protected ones in place, first, so none can be moved", () => {
    const l = layout("bwrap-pin");
    const a = bwrapArgs(agentSandboxPolicy(l));
    const config = path.join(l.distRoot, "config");
    const parent = path.dirname(l.gateDir);
    const proofParent = path.dirname(l.proof);
    for (const d of [config, l.distRoot, parent, proofParent]) {
      const at = a.findIndex((x, i) => x === "--bind" && a[i + 1] === d);
      expect(at).toBeGreaterThan(0);
      expect(a[at + 2]).toBe(d);
      // Before what they hold is bound, so a pin never covers it.
      expect(at).toBeLessThan(a.indexOf("--ro-bind"));
    }
    // Outer ones first.
    const pos = (d: string) =>
      a.findIndex((x, i) => x === "--bind" && a[i + 1] === d);
    expect(pos(l.distRoot)).toBeLessThan(pos(config));
  });

  it("masks a container socket once, at its real path (/var/run is a link to /run)", () => {
    const p = agentSandboxPolicy(layout("bwrap-link"));
    const socks = new Set(["/run/docker.sock"]);
    const real = (f: string) => f.replace(/^\/var\/run\//, "/run/");
    const a = bwrapArgs(
      p,
      (f) => fs.existsSync(f) || socks.has(real(f)),
      (f) => (socks.has(real(f)) ? real(f) : f),
    );
    const masked = a.filter((_, i) => a[i - 1] === "/dev/null");
    // Once, at /run (the machine may have other engines' sockets too).
    expect(masked.filter((x) => x === "/run/docker.sock")).toHaveLength(1);
    expect(a).not.toContain("/var/run/docker.sock");
  });
});

describe("sandboxSetting (issue 936)", () => {
  // Issue 1391: on a strict install. A personal one's default is below.
  it("is on unless the person turned it off, for all or for one agent", () => {
    const cfg = (agents: Record<string, unknown>) =>
      readAgentsConfig(
        { agents: {} } as DenConfig,
        {
          install_mode: "strict",
          agents,
        } as UserConfig,
      );
    expect(sandboxSetting(cfg({}), "a1")).toBe(true);
    expect(sandboxSetting(cfg({ sandbox: "off" }), "a1")).toBe(false);
    expect(sandboxSetting(cfg({ sandbox: false }), "a1")).toBe(false);
    expect(sandboxSetting(cfg({ a1: { sandbox: "off" } }), "a1")).toBe(false);
    expect(sandboxSetting(cfg({ a1: { sandbox: "off" } }), "a2")).toBe(true);
    expect(
      sandboxSetting(cfg({ sandbox: "off", a1: { sandbox: "on" } }), "a1"),
    ).toBe(true);
  });

  it("is off on a personal install unless the person turned it on (issue 1391)", () => {
    const cfg = (agents: Record<string, unknown>) =>
      readAgentsConfig({ agents: {} } as DenConfig, { agents } as UserConfig);
    expect(sandboxSetting(cfg({}), "a1")).toBe(false);
    expect(sandboxSetting(cfg({ sandbox: "on" }), "a1")).toBe(true);
    expect(sandboxSetting(cfg({ a1: { sandbox: "on" } }), "a1")).toBe(true);
    expect(sandboxSetting(cfg({ a1: { sandbox: "on" } }), "a2")).toBe(false);
  });

  it("refuses a value that is not on or off", () => {
    const user = (agents: Record<string, unknown>) =>
      readAgentsConfig({ agents: {} } as DenConfig, { agents } as UserConfig);
    expect(() => user({ sandbox: "maybe" })).toThrow(
      /agents.sandbox: must be on, off or required/,
    );
    expect(() => user({ a1: { sandbox: 1 } })).toThrow(
      /agents.a1.sandbox: must be on, off or required/,
    );
  });

  it("takes required, and more socket folders, from user.yml", () => {
    const c = readAgentsConfig(
      { agents: {} } as DenConfig,
      {
        agents: {
          sandbox: "required",
          sandbox_sockets: ["/var/x"],
          a1: { sandbox: "required" },
        },
      } as unknown as UserConfig,
    );
    expect(c.sandbox).toBe(true);
    expect(c.sandboxRequired).toBe(true);
    expect(c.sandboxSockets).toEqual(["/var/x"]);
    expect(c.agents.a1).toEqual({
      grants: [],
      sandbox: true,
      sandboxRequired: true,
    });
    expect(() =>
      readAgentsConfig(
        { agents: {} } as DenConfig,
        {
          agents: { sandbox_sockets: ["rel/x"] },
        } as unknown as UserConfig,
      ),
    ).toThrow(/agents.sandbox_sockets: a list of absolute folder paths/);
  });

  it("is never read from the org config, a file agents may edit", () => {
    const org = (agents: Record<string, unknown>) =>
      readAgentsConfig({ agents } as DenConfig, {} as UserConfig);
    expect(() => org({ sandbox: "off" })).toThrow(/config\/local\/user.yml/);
    expect(() => org({ a1: { sandbox: "off" } })).toThrow(
      /agents.a1.sandbox: set it in config\/local\/user.yml/,
    );
  });
});

describe("sandboxFor (issue 936)", () => {
  it("on Linux, a bwrap that can't start here is no sandbox, and says why", () => {
    const l = layout("wrap-bwrap-broken");
    const w = sandboxFor(["claude"], l, {
      platform: "linux",
      on: true,
      which: () => "/usr/bin/bwrap",
      bwrapWorks: () => "setting up uid map: Permission denied",
    });
    expect(w).toMatchObject({ applied: false, argv: ["claude"] });
    expect(w.reason).toBe(
      "bwrap can't start a sandbox here: setting up uid map: Permission denied",
    );
  });

  it("wraps the argv with sandbox-exec on macOS and marks the env", () => {
    const l = layout("wrap-mac");
    const w = sandboxFor(["claude", "--x"], l, {
      platform: "darwin",
      on: true,
      which: () => "/usr/bin/sandbox-exec",
    });
    expect(w.applied).toBe(true);
    expect(w.argv[0]).toBe("/usr/bin/sandbox-exec");
    expect(w.argv[1]).toBe("-p");
    expect(w.argv.slice(-2)).toEqual(["claude", "--x"]);
    expect(w.env).toEqual({ [AGENT_SANDBOX_ENV]: "1" });
  });

  it("issue 1369: on macOS too, the session's writable state folders exist before it starts (the audit queue's)", () => {
    const l = layout("wrap-mac-dirs");
    fs.rmSync(path.join(l.stateDir, "audit"), { recursive: true, force: true });
    const w = sandboxFor(["claude"], l, {
      platform: "darwin",
      on: true,
      which: () => "/usr/bin/sandbox-exec",
    });
    expect(w.applied).toBe(true);
    expect(fs.statSync(path.join(l.stateDir, "audit")).isDirectory()).toBe(
      true,
    );
  });

  it("wraps with bwrap on Linux when bwrap is there", () => {
    const l = layout("wrap-linux");
    const w = sandboxFor(["claude"], l, {
      platform: "linux",
      on: true,
      which: (b) => (b === "bwrap" ? "/usr/bin/bwrap" : undefined),
      bwrapWorks: () => null,
    });
    expect(w.applied).toBe(true);
    expect(w.argv[0]).toBe("/usr/bin/bwrap");
    expect(w.argv.slice(-2)).toEqual(["--", "claude"]);
  });

  it("starts unsandboxed, and says why, without bwrap or when off", () => {
    const l = layout("wrap-none");
    const none = sandboxFor(["claude"], l, {
      platform: "linux",
      on: true,
      which: () => undefined,
    });
    expect(none).toMatchObject({ applied: false, argv: ["claude"], env: {} });
    expect(none.reason).toMatch(/bwrap/);
    const off = sandboxFor(["claude"], l, {
      platform: "darwin",
      on: false,
      which: () => "/usr/bin/sandbox-exec",
    });
    expect(off).toMatchObject({ applied: false, argv: ["claude"] });
    expect(off.reason).toMatch(/off for this agent/);
    const win = sandboxFor(["claude"], l, {
      platform: "win32",
      on: true,
      which: () => undefined,
    });
    expect(win).toMatchObject({ applied: false, argv: ["claude"] });
  });
});

/** The real OS sandbox, when this machine has it. */
function realTool(): "darwin" | "linux" | null {
  if (process.platform === "darwin" && fs.existsSync("/usr/bin/sandbox-exec"))
    return "darwin";
  if (process.platform === "linux") {
    const r = spawnSync("bwrap", ["--dev-bind", "/", "/", "true"]);
    if (r.status === 0) return "linux";
  }
  return null;
}
const real = realTool();
const itReal = real ? it : it.skip;
const l0 = () => layout(`real-${Math.random().toString(36).slice(2, 8)}`);

/** Runs `script` with /bin/sh inside the agent's sandbox; its exit lines. */
function inSandbox(l: ReturnType<typeof layout>, script: string): string {
  const w = sandboxFor(["/bin/sh", "-c", script], l, {
    platform: process.platform,
    on: true,
  });
  expect(w.applied).toBe(true);
  const r = spawnSync(w.argv[0], w.argv.slice(1), {
    encoding: "utf-8",
    env: { ...process.env, ...w.env },
  });
  return r.stdout;
}

/** One line per step: `<name>=<exit code>`. */
const step = (name: string, cmd: string) =>
  `( ${cmd} ) >/dev/null 2>&1; echo ${name}=$?`;

describe("an agent in bypass mode, in its sandbox (issue 936)", () => {
  itReal(
    "issue 1369: a den command's audit entry is kept: queued in the sandbox, readable outside it",
    () => {
      const l = layout("real-audit");
      const script = path.join(l.base, "work", "audit-one.ts");
      const repo = path.resolve(__dirname, "..", "..", "..");
      fs.writeFileSync(
        script,
        `import { auditConfig } from ${JSON.stringify(path.join(repo, "src", "shared", "config-audit.ts"))};\n` +
          `auditConfig({ verb: "agents", detail: "restart a1 in north: ok" }, process.argv[2]);\n`,
      );
      const tsx = path.join(repo, "node_modules", ".bin", "tsx");
      const out = inSandbox(
        l,
        [
          step("trail", `echo x >> ${l.stateDir}/audit.jsonl`),
          step("den", `TSX_DISABLE_CACHE=1 ${tsx} ${script} ${l.stateDir}`),
        ].join("; "),
      );
      // The file itself stays read-only: the entry goes to the queue.
      expect(out).toMatch(/^trail=[1-9]/m);
      expect(out).toMatch(/^den=0/m);
      expect(readAuditRows(l.stateDir).map((r) => r.detail)).toEqual([
        "restart a1 in north: ok",
      ]);
    },
  );

  itReal(
    "can't change its own mode, the gate settings or the settings file",
    () => {
      const l = layout("real-write");
      const out = inSandbox(
        l,
        [
          step("mode", `echo '{"mode":"all"}' > ${l.stateDir}/agents/a1.json`),
          step("gate", `echo '{}' > ${l.gateDir}/settings.json`),
          step("gatemv", `mv ${l.gateDir}/settings.json ${l.gateDir}/old.json`),
          step("user", `echo 'x: 1' >> ${l.distRoot}/config/local/user.yml`),
          step("newstate", `echo x > ${l.stateDir}/new.json`),
          step("rmrec", `rm -f ${l.stateDir}/agents/a1.json`),
          step("mvstate", `mv ${l.stateDir} ${l.base}/moved`),
          step("mvconfig", `mv ${l.distRoot}/config ${l.distRoot}/config2`),
          step("ownsettings", `echo '{}' > ${l.own}/settings.json`),
          step("ownmcp", `rm -f ${l.own}/mcp.json`),
        ].join("; "),
      );
      for (const s of [
        "mode",
        "gate",
        "gatemv",
        "user",
        "newstate",
        "rmrec",
        "mvstate",
        "mvconfig",
        "ownsettings",
        "ownmcp",
      ])
        expect(out).toMatch(new RegExp(`^${s}=[1-9]`, "m"));
      expect(
        fs.readFileSync(path.join(l.stateDir, "agents", "a1.json"), "utf-8"),
      ).toContain("permission");
      expect(
        fs.readFileSync(
          path.join(l.distRoot, "config", "local", "user.yml"),
          "utf-8",
        ),
      ).toBe("local_dev: true\n");
    },
  );

  itReal(
    "can't move the gate store, or a folder above it, to forge its settings",
    () => {
      const l = layout("real-rename");
      const parent = path.dirname(l.gateDir);
      const out = inSandbox(
        l,
        [
          step("mvgate", `mv ${l.gateDir} ${l.gateDir}.old`),
          step("mvparent", `mv ${parent} ${parent}.old`),
          step(
            "over",
            `echo '{"boxes":[]}' > ${l.gateDir}/s.tmp && mv ${l.gateDir}/s.tmp ${l.gateDir}/settings.json`,
          ),
          step("link", `ln ${l.gateDir}/settings.json ${l.gateDir}/h.json`),
          step("rmset", `rm -f ${l.gateDir}/settings.json`),
        ].join("; "),
      );
      for (const s of ["mvgate", "mvparent", "over", "link", "rmset"])
        expect(out).toMatch(new RegExp(`^${s}=[1-9]`, "m"));
      expect(
        fs.readFileSync(path.join(l.gateDir, "settings.json"), "utf-8"),
      ).toBe("{}\n");
    },
  );

  itReal(
    "connects to no unix socket of the person's, only the allowed ones",
    async () => {
      const l = layout("real-socks");
      // The person's socket, in its runtime folder (XDG_RUNTIME_DIR).
      const run0 = path.join(l.base, "run");
      fs.mkdirSync(run0);
      const other = path.join(run0, "o.sock");
      const okDir = path.join(l.base, "ok");
      fs.mkdirSync(okDir);
      const ok = path.join(okDir, "k.sock");
      const servers = [other, ok].map((p) => {
        const sv = net.createServer((c) => c.end("hi\n"));
        return new Promise<net.Server>((r) => sv.listen(p, () => r(sv)));
      });
      const live = await Promise.all(servers);
      try {
        const probe = (sock: string) =>
          `require("net").connect(${JSON.stringify(sock)}).on("connect",()=>{console.log("connected");process.exit(0)}).on("error",()=>{console.log("refused");process.exit(0)})`;
        const run = (sock: string) => {
          const w = sandboxFor(
            [process.execPath, "-e", probe(sock)],
            {
              ...l,
              socketsAllowed: [okDir],
              env: { ...process.env, XDG_RUNTIME_DIR: run0 },
            },
            { platform: process.platform, on: true },
          );
          const r = spawnSync(w.argv[0]!, w.argv.slice(1), {
            encoding: "utf-8",
            env: { ...process.env, ...w.env },
          });
          return r.stdout.trim();
        };
        expect(run(other)).toBe("refused");
        expect(run(ok)).toBe("connected");
      } finally {
        for (const sv of live) sv.close();
      }
    },
  );

  itReal(
    "can't write, remove or move the local-proof folder or its files",
    () => {
      const l = layout("real-proof-write");
      const parent = path.dirname(l.proof);
      const out = inSandbox(
        l,
        [
          step("write", `echo x > ${l.proof}/k`),
          step("new", `echo x > ${l.proof}/planted`),
          step("rm", `rm ${l.proof}/k`),
          step("mv", `mv ${l.proof} ${l.proof}.old`),
          step("mvparent", `mv ${parent} ${parent}.old`),
        ].join("; "),
      );
      for (const s of ["write", "new", "rm", "mv", "mvparent"])
        expect(out).toMatch(new RegExp(`^${s}=[1-9]`, "m"));
      expect(fs.readFileSync(path.join(l.proof, "k"), "utf-8")).toBe("proof\n");
    },
  );

  itReal("can't start a program through LaunchServices", () => {
    // Finder runs already: kept in the background, nothing shows if it opens.
    const out = inSandbox(l0(), step("open", "/usr/bin/open -g -j -a Finder"));
    expect(out).toMatch(/^open=[1-9]/m);
  });

  itReal("can't read Den's private files or another agent's token", () => {
    const l = layout("real-read");
    const out = inSandbox(
      l,
      [
        step("secret", `grep -q person-secret ${l.stateDir}/web.secret`),
        step("sessions", `cat ${l.stateDir}/web-sessions.json | grep -q .`),
        step("hub", `grep -q hub-token ${l.stateDir}/hub/token`),
        step("other", `grep -q other-token ${l.stateDir}/actor-token/a2/token`),
        step("own", `grep -q own-token ${l.stateDir}/actor-token/a1/token`),
        step("record", `grep -q permission ${l.stateDir}/agents/a1.json`),
        step("web", `grep -q port ${l.stateDir}/web.json`),
        step("proof", `cat ${l.proof}/k`),
        step("list", `ls ${l.stateDir}`),
        `echo "names=$(ls -A ${l.stateDir} 2>/dev/null | tr '\\n' ' ')"`,
        ...KNOWN_PRIVATE.map((f, i) =>
          step(`private${i}`, `grep -q private ${l.stateDir}/${f}`),
        ),
      ].join("; "),
    );
    for (const s of [
      "secret",
      "sessions",
      "hub",
      "other",
      "proof",
      ...KNOWN_PRIVATE.map((_, i) => `private${i}`),
    ])
      expect(out).toMatch(new RegExp(`^${s}=[1-9]`, "m"));
    // macOS refuses the listing; on Linux it lists only what is bound
    // back (the tmpfs hides the rest): no private file is named either way.
    if (real === "darwin") expect(out).toMatch(/^list=[1-9]/m);
    const names = /^names=(.*)$/m.exec(out)?.[1] ?? "";
    // The private files at its top level (folders it reads into, like
    // hub/, show; their private files don't).
    for (const f of [
      "web.secret",
      ...KNOWN_PRIVATE.filter((x) => !x.includes(path.sep)),
    ])
      expect(names.split(" ")).not.toContain(f);
    expect(out).toMatch(/^web=0$/m);
    expect(out).toMatch(/^own=0$/m);
    expect(out).toMatch(/^record=0$/m);
  });

  itReal(
    "still writes its own folder, the slot queue and work outside Den's state",
    () => {
      const l = layout("real-own");
      const out = inSandbox(
        l,
        [
          step("handoff", `echo '## Objective' > ${l.own}/handoff.md`),
          step(
            "notes",
            `echo n > ${l.own}/notes.md && mv ${l.own}/notes.md ${l.own}/notes-1.md`,
          ),
          step("work", `echo w > ${l.base}/work/file`),
          step("slot", `echo '{}' > ${l.gateDir}/slots/mine.json`),
          step("lock", `mkdir ${l.gateDir}/lock && rmdir ${l.gateDir}/lock`),
          step("log", `echo '{}' >> ${l.gateDir}/events.jsonl`),
        ].join("; "),
      );
      for (const s of ["slot", "lock", "log"])
        expect(out).toMatch(new RegExp(`^${s}=0$`, "m"));
      expect(out).toMatch(/^handoff=0$/m);
      expect(out).toMatch(/^notes=0$/m);
      expect(out).toMatch(/^work=0$/m);
      expect(fs.readFileSync(path.join(l.own, "handoff.md"), "utf-8")).toBe(
        "## Objective\n",
      );
    },
  );

  itReal("can't reach the session host's socket", async () => {
    const l = layout("real-sock");
    const sock = path.join(l.stateDir, "sessions.sock");
    const server = net.createServer((c) => c.end("hello\n"));
    await new Promise<void>((r) => server.listen(sock, r));
    try {
      const w = sandboxFor(
        [
          process.execPath,
          "-e",
          `require("net").connect(${JSON.stringify(sock)}).on("connect",()=>{console.log("connected");process.exit(0)}).on("error",()=>{console.log("refused");process.exit(0)})`,
        ],
        l,
        { platform: process.platform, on: true },
      );
      const r = await new Promise<string>((resolve) => {
        const k = spawn(w.argv[0], w.argv.slice(1), {
          env: { ...process.env, ...w.env },
        });
        let s = "";
        k.stdout.on("data", (d: Buffer) => (s += d.toString()));
        k.on("exit", () => resolve(s));
      });
      expect(r.trim()).toBe("refused");
    } finally {
      server.close();
    }
  });
});

describe("agents start runs the agent in its sandbox (issue 936)", () => {
  async function plannerRig() {
    const r = await rig();
    const packs = path.join(r.dir, "personas");
    fs.mkdirSync(packs, { recursive: true });
    fs.writeFileSync(
      path.join(packs, "planner.md"),
      "---\nname: planner\n---\nYou plan.\n",
    );
    r.config.personaPacks = ["personas"];
    // Den's own sandbox step, not the rig's stand-in.
    delete r.deps.agentSandbox;
    return r;
  }
  const record = (stateDir: string) =>
    JSON.parse(
      fs.readFileSync(path.join(stateDir, "agents", "planner.json"), "utf-8"),
    ) as { sandbox?: { applied: boolean; tool?: string; reason?: string } };

  const onMac = process.platform === "darwin" ? it : it.skip;
  onMac(
    "wraps the session's argv with sandbox-exec and records it",
    async () => {
      const r = await plannerRig();
      expect(
        await cmdAgents(
          ["start", "-w", "north", "--persona", "planner"],
          r.deps,
        ),
      ).toBe(0);
      const p = r.made[0]!;
      expect(p.file).toBe("/usr/bin/sandbox-exec");
      expect(p.args[0]).toBe("-p");
      expect(p.args[1]).toContain(`(subpath "${fs.realpathSync(r.stateDir)}")`);
      expect((p.opts.env as Record<string, string>)[AGENT_SANDBOX_ENV]).toBe(
        "1",
      );
      expect(record(r.stateDir).sandbox).toEqual({
        applied: true,
        tool: "sandbox-exec",
      });
    },
  );

  it("agents.sandbox: required refuses a start where no sandbox applies", async () => {
    const r = await plannerRig();
    r.config.sandboxRequired = true;
    r.deps.agentSandbox = (argv) => ({
      applied: false,
      argv,
      env: {},
      reason: "bwrap (bubblewrap) is not installed",
    });
    expect(
      await cmdAgents(["start", "-w", "north", "--persona", "planner"], r.deps),
    ).not.toBe(0);
    expect(r.made).toHaveLength(0);
    expect(r.err.join("\n")).toContain(
      "planner needs the agent sandbox (agents.sandbox: required), and it can't apply here: bwrap (bubblewrap) is not installed",
    );
  });

  it("agents.<id>.sandbox: off starts it unwrapped, and the record says why", async () => {
    const r = await plannerRig();
    r.config.agents.planner = { grants: [], sandbox: false };
    expect(
      await cmdAgents(["start", "-w", "north", "--persona", "planner"], r.deps),
    ).toBe(0);
    const p = r.made[0]!;
    expect(p.file).not.toMatch(/sandbox-exec|bwrap/);
    expect(
      (p.opts.env as Record<string, string>)[AGENT_SANDBOX_ENV],
    ).toBeUndefined();
    expect(record(r.stateDir).sandbox).toEqual({
      applied: false,
      reason: "the sandbox is off for this agent in user.yml",
    });
  });

  it("the start line and doctor name the agent that runs outside it", async () => {
    const r = await plannerRig();
    r.config.agents.planner = { grants: [], sandbox: false };
    expect(
      await cmdAgents(["start", "-w", "north", "--persona", "planner"], r.deps),
    ).toBe(0);
    expect(r.err.join("\n")).toContain(
      "planner runs outside the agent sandbox (Den's state is writable to it): the sandbox is off for this agent in user.yml",
    );
    r.out.length = 0;
    await cmdAgents(["doctor", "--json"], r.deps);
    const rep = JSON.parse(r.out.join("\n")) as { sandbox: SandboxReport };
    expect(rep.sandbox.outside).toEqual([
      {
        id: "planner",
        project: "north",
        reason: "the sandbox is off for this agent in user.yml",
      },
    ]);
    expect(sandboxLines(rep.sandbox)).toContain(
      "  ⚠ planner (north) runs outside it: the sandbox is off for this agent in user.yml",
    );
  });
});

describe("sandboxErrorHint (issue 936)", () => {
  const inside = { [AGENT_SANDBOX_ENV]: "1", DEN_AGENT: "agent:a1" };
  const eperm = Object.assign(
    new Error("EPERM: operation not permitted, open 'x'"),
    { code: "EPERM" },
  );
  it("names the tool or held write to use for the verb", () => {
    const h = sandboxErrorHint(eperm, inside, "acme", [
      "agents",
      "start",
      "-w",
      "north",
    ]);
    expect(h).toContain("`acme agents start` writes Den's state");
    expect(h).toContain("agent_create tool");
    expect(
      sandboxErrorHint(new Error("connect EPERM /s.sock"), inside, "acme", [
        "agents",
        "list",
      ]),
    ).toContain("status and org_summary tools");
  });
  it("never sends the agent to the person for a setting", () => {
    for (const args of [["agents", "stop", "x"], ["gate", "set"], []]) {
      const h = sandboxErrorHint(eperm, inside, "acme", args)!;
      expect(h).toContain("held writes");
      expect(h).not.toMatch(/user\.yml|sandbox: off/);
    }
  });
  it("is nothing outside the sandbox, or for another error", () => {
    expect(sandboxErrorHint(eperm, {}, "acme")).toBeNull();
    expect(
      sandboxErrorHint(new Error("no such project"), inside, "acme"),
    ).toBeNull();
  });
});

describe("localProofDirs (issue 936)", () => {
  it("names the OS app folder's local-proof, and the env's own", () => {
    expect(localProofDirs({}, "darwin", "/h")).toEqual([
      "/h/Library/Application Support/den/local-proof",
    ]);
    expect(localProofDirs({}, "linux", "/h")).toEqual([
      "/h/.local/state/den/local-proof",
    ]);
    expect(
      localProofDirs(
        {
          XDG_STATE_HOME: "/x",
          DEN_LOCAL_PROOF_DIR: "/p",
          ACME_LOCAL_PROOF_DIR: "/q",
        },
        "linux",
        "/h",
        "ACME_LOCAL_PROOF_DIR",
      ),
    ).toEqual(["/x/den/local-proof", "/p", "/q"]);
  });
});

describe("agentSandboxInput (issue 936)", () => {
  it("denies an agent the machine's local-proof folders, as the start builds it", () => {
    const i = agentSandboxInput({
      stateDir: "/s",
      distRoot: "/r",
      env: { DEN_LOCAL_PROOF_DIR: "/p" },
      agentId: "a1",
      platform: "darwin",
      home: "/h",
    });
    expect(i.deniedDirs).toEqual([
      "/h/Library/Application Support/den/local-proof",
      "/p",
    ]);
    expect(agentSandboxPolicy(i).unreadable).toEqual(
      expect.arrayContaining([
        "/h/Library/Application Support/den/local-proof",
      ]),
    );
  });
});
