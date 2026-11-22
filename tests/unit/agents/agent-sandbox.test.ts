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
  sandboxErrorHint,
  sandboxFor,
  sandboxSetting,
} from "../../../src/shared/agents/sandbox.js";
import {
  cmdAgents,
  sandboxLines,
  type SandboxReport,
} from "../../../src/ui/cli/agents-command.js";
import { cleanupRigs, rig } from "./helpers/rig.js";
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
  return { base, stateDir, distRoot, gateDir, own, agentId: "a1" };
}

describe("agentSandboxPolicy (issue 936)", () => {
  it("makes the state dir and config/local read-only", () => {
    const l = layout("policy");
    const p = agentSandboxPolicy(l);
    expect(p.readOnly).toEqual([
      l.stateDir,
      path.join(l.distRoot, "config", "local"),
    ]);
  });

  it("leaves its own folder and the slot queue writable, launch files and gate settings locked", () => {
    const l = layout("policy-own");
    const p = agentSandboxPolicy(l);
    expect(p.writable).toEqual([l.own, l.gateDir]);
    for (const f of ["settings.json", "mcp.json", "compacting.json"])
      expect(p.locked).toContain(path.join(l.own, f));
    expect(p.locked).toContain(path.join(l.gateDir, "settings.json"));
  });

  it("hides Den's private files and other agents' tokens", () => {
    const l = layout("policy-read");
    const p = agentSandboxPolicy(l);
    expect(p.hidden).toEqual(
      expect.arrayContaining([
        path.join(l.stateDir, "web.secret"),
        path.join(l.stateDir, "web-sessions.json"),
        path.join(l.stateDir, "hub", "token"),
        path.join(l.stateDir, "gate", "runner-tokens.json"),
      ]),
    );
    expect(p.tokensDir).toBe(path.join(l.stateDir, "actor-token"));
    expect(p.ownTokenDir).toBe(path.join(l.stateDir, "actor-token", "a1"));
    expect(p.sockets).toEqual([path.join(l.stateDir, "sessions.sock")]);
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

  it("binds the read-only paths, the own folder back, and its launch files read-only", () => {
    const l = layout("bwrap");
    const a = bwrapArgs(agentSandboxPolicy(l));
    const pairs = a.join(" ");
    expect(pairs).toContain(`--ro-bind ${l.stateDir} ${l.stateDir}`);
    expect(pairs).toContain(`--bind ${l.own} ${l.own}`);
    expect(pairs).toContain(
      `--ro-bind ${path.join(l.own, "settings.json")} ${path.join(l.own, "settings.json")}`,
    );
    expect(pairs).toContain(
      `--ro-bind /dev/null ${path.join(l.stateDir, "web.secret")}`,
    );
    expect(pairs).toContain(`--tmpfs ${path.join(l.stateDir, "actor-token")}`);
    // The own folder is bound after the state dir, so it wins.
    expect(a.indexOf(l.own)).toBeGreaterThan(a.indexOf(l.stateDir));
    expect(a[a.length - 1]).toBe("--");
  });
});

describe("sandboxSetting (issue 936)", () => {
  it("is on unless the person turned it off, for all or for one agent", () => {
    const cfg = (agents: Record<string, unknown>) =>
      readAgentsConfig({ agents: {} } as DenConfig, { agents } as UserConfig);
    expect(sandboxSetting(cfg({}), "a1")).toBe(true);
    expect(sandboxSetting(cfg({ sandbox: "off" }), "a1")).toBe(false);
    expect(sandboxSetting(cfg({ sandbox: false }), "a1")).toBe(false);
    expect(sandboxSetting(cfg({ a1: { sandbox: "off" } }), "a1")).toBe(false);
    expect(sandboxSetting(cfg({ a1: { sandbox: "off" } }), "a2")).toBe(true);
    expect(
      sandboxSetting(cfg({ sandbox: "off", a1: { sandbox: "on" } }), "a1"),
    ).toBe(true);
  });

  it("refuses a value that is not on or off", () => {
    const user = (agents: Record<string, unknown>) =>
      readAgentsConfig({ agents: {} } as DenConfig, { agents } as UserConfig);
    expect(() => user({ sandbox: "maybe" })).toThrow(
      /agents.sandbox: must be on or off/,
    );
    expect(() => user({ a1: { sandbox: 1 } })).toThrow(
      /agents.a1.sandbox: must be on or off/,
    );
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

  it("wraps with bwrap on Linux when bwrap is there", () => {
    const l = layout("wrap-linux");
    const w = sandboxFor(["claude"], l, {
      platform: "linux",
      on: true,
      which: (b) => (b === "bwrap" ? "/usr/bin/bwrap" : undefined),
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
      ].join("; "),
    );
    for (const s of ["secret", "sessions", "hub", "other"])
      expect(out).toMatch(new RegExp(`^${s}=[1-9]`, "m"));
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
      "  planner (north) runs outside it: the sandbox is off for this agent in user.yml",
    );
  });
});

describe("sandboxErrorHint (issue 936)", () => {
  const inside = { [AGENT_SANDBOX_ENV]: "1", DEN_AGENT: "agent:a1" };
  it("says what happened and what to use, for a refused write inside", () => {
    const e = Object.assign(
      new Error("EPERM: operation not permitted, open 'x'"),
      {
        code: "EPERM",
      },
    );
    const h = sandboxErrorHint(e, inside, "acme");
    expect(h).toContain("read-only");
    expect(h).toContain("agent_create");
    expect(h).toContain("agents.a1.sandbox: off");
    expect(h).toContain("`acme doctor`");
    expect(
      sandboxErrorHint(new Error("connect EPERM /s.sock"), inside, "acme"),
    ).toBeTruthy();
  });
  it("is nothing outside the sandbox, or for another error", () => {
    const e = Object.assign(new Error("EPERM"), { code: "EPERM" });
    expect(sandboxErrorHint(e, {}, "acme")).toBeNull();
    expect(
      sandboxErrorHint(new Error("no such project"), inside, "acme"),
    ).toBeNull();
  });
});
