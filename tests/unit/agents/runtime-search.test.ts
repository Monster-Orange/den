/**
 * AG-0.1: a runtime's CLI is found the way the person's terminal would
 * find it, not only on the server's own PATH (a launchd service's leaves
 * out ~/.local/bin, where Claude Code's native installer puts `claude`).
 *
 * Fake bins in temp dirs (`#!/bin/sh` scripts) and a fake login shell
 * only: no test runs this machine's login shell or the real `claude`.
 * tests/setup.ts turns the login shell and the install directories off
 * for every other suite; the cases here that need them turn them back on
 * for themselves.
 */
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as yaml from "yaml";
import { configuredRuntimeBin } from "../../../src/shared/den-config.js";
import {
  agentSessionEnv,
  getRuntime,
} from "../../../src/shared/agents/runtimes.js";
import {
  checkBinSetting,
  clearVersionCache,
  initLoginPath,
  LOGIN_PATH_TIMEOUT_MS,
  loginPath,
  resolveLoginPath,
  runtimeVersion,
  setLoginPath,
} from "../../../src/shared/agents/runtime-search.js";
import { plainSessionEnv } from "../../../src/ui/cli/sessions-command.js";
import { cmdAgents } from "../../../src/ui/cli/agents-command.js";
import { CLAUDE_SHIM, cleanupRigs, rig } from "./helpers/rig.js";

const tmps: string[] = [];
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ["DEN_LOGIN_SHELL", "DEN_RUNTIME_DIRS"])
    saved[k] = process.env[k];
});
afterEach(async () => {
  for (const [k, v] of Object.entries(saved))
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  setLoginPath(undefined);
  clearVersionCache();
  await cleanupRigs();
  for (const d of tmps.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-rs-")));
  tmps.push(d);
  return d;
}

function write(file: string, content: string, mode = 0o755): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, { mode });
  return file;
}

/** A fake `claude` in `dir` that answers --version and records any other run. */
function claudeIn(
  dir: string,
  version = "9.9.9",
): { bin: string; ran: string } {
  const ran = path.join(path.dirname(dir), `ran-${path.basename(dir)}`);
  return {
    bin: write(path.join(dir, "claude"), CLAUDE_SHIM(ran, version)),
    ran,
  };
}

/**
 * A fake login shell: prints startup noise (as a profile might), puts
 * `loginDir` first on PATH, then runs the command it is given (`-lc cmd`).
 */
function fakeShell(root: string, loginDir: string, before = ""): string {
  return write(
    path.join(root, "fake-shell"),
    [
      "#!/bin/sh",
      before,
      'echo "Welcome back: profile noise $PATH"',
      `PATH="${loginDir}:/usr/bin:/bin"`,
      "export PATH",
      'shift; eval "$1"',
      'echo "more noise after"',
      "",
    ].join("\n"),
  );
}

const rt = () => getRuntime("den-claude")!;

describe("AG-0.1: install directories", () => {
  it("finds claude only in ~/.local/bin (a fake HOME), under a PATH without it; the agent's session PATH has it", async () => {
    delete process.env.DEN_RUNTIME_DIRS;
    const home = path.join(tmp(), "home");
    const local = path.join(home, ".local", "bin");
    const { bin, ran } = claudeIn(local);
    const env = { HOME: home, PATH: "/usr/bin:/bin" };

    const det = rt().detect(env, { bin: null });
    expect(det).toMatchObject({
      available: true,
      path: bin,
      source: "well-known",
    });
    expect(det.searched?.slice(0, 3)).toEqual(["/usr/bin", "/bin", local]);

    // The agent's env: its PATH keeps the caller's, then the directory.
    const agentEnv = agentSessionEnv(env, {}, {}, "planner");
    expect(agentEnv.PATH!.split(":").slice(0, 3)).toEqual([
      "/usr/bin",
      "/bin",
      local,
    ]);
    // A plain session gets the same PATH.
    expect(plainSessionEnv(env).PATH).toBe(agentEnv.PATH);

    // `agents start` end to end: the session runs that claude, with it on PATH.
    const r = await rig();
    r.deps.env = { ...env, SOME_TOKEN: "secret-value-123" };
    expect(
      await cmdAgents(["start", "-w", "north", "--persona", "planner"], r.deps),
    ).toBe(0);
    const p = r.made[0];
    expect(p.file).toBe(bin);
    expect(String(p.opts.env.PATH).split(":")).toContain(local);
    expect(p.opts.env.SOME_TOKEN).toBeUndefined();
    expect(fs.existsSync(ran)).toBe(false);
  });

  it("DEN_RUNTIME_DIRS replaces the install directories (empty: none)", () => {
    const home = path.join(tmp(), "home");
    claudeIn(path.join(home, ".local", "bin"));
    const env = { HOME: home, PATH: "/usr/bin:/bin", DEN_RUNTIME_DIRS: "" };
    expect(rt().detect(env, { bin: null })).toMatchObject({
      available: false,
      searched: ["/usr/bin", "/bin"],
    });
  });
});

describe("AG-0.1: the login shell's PATH", () => {
  it("is asked once ($SHELL -lc, startup noise ignored) and searched first", async () => {
    delete process.env.DEN_LOGIN_SHELL;
    const root = tmp();
    const loginDir = path.join(root, "login-bin");
    const { bin } = claudeIn(loginDir);
    const shell = fakeShell(root, loginDir);
    const env = { SHELL: shell, PATH: "/usr/bin:/bin" };

    expect(await resolveLoginPath({ env })).toBe(
      [loginDir, "/usr/bin", "/bin"].join(":"),
    );
    await initLoginPath({ env });
    expect(loginPath()).toBe([loginDir, "/usr/bin", "/bin"].join(":"));
    expect(rt().detect(env, { bin: null })).toMatchObject({
      available: true,
      path: bin,
      source: "login-shell",
    });
    // Sessions get it too, before the caller's own.
    expect(agentSessionEnv(env, {}, {}, "planner").PATH).toBe(
      [loginDir, "/usr/bin:/bin"].join(":"),
    );
  });

  it("times out (3 s by default) and falls back to the current PATH", async () => {
    delete process.env.DEN_LOGIN_SHELL;
    expect(LOGIN_PATH_TIMEOUT_MS).toBe(3000);
    const root = tmp();
    const loginDir = path.join(root, "login-bin");
    claudeIn(loginDir);
    const pathDir = path.join(root, "path-bin");
    const { bin } = claudeIn(pathDir);
    // A shell whose startup never finishes.
    const shell = fakeShell(root, loginDir, "exec sleep 30");
    const env = { SHELL: shell, PATH: `${pathDir}:/usr/bin:/bin` };

    expect(await resolveLoginPath({ env, timeoutMs: 200 })).toBeUndefined();
    await initLoginPath({ env, timeoutMs: 200 });
    expect(loginPath()).toBeUndefined();
    expect(rt().detect(env, { bin: null })).toMatchObject({
      available: true,
      path: bin,
      source: "PATH",
    });
  });

  it("no shell, a relative one or DEN_LOGIN_SHELL=off: nothing is asked", async () => {
    delete process.env.DEN_LOGIN_SHELL;
    expect(await resolveLoginPath({ env: {} })).toBeUndefined();
    expect(await resolveLoginPath({ env: { SHELL: "sh" } })).toBeUndefined();
    const root = tmp();
    const ran = path.join(root, "ran");
    const shell = write(path.join(root, "sh"), `#!/bin/sh\ntouch "${ran}"\n`);
    expect(
      await resolveLoginPath({ env: { SHELL: shell, DEN_LOGIN_SHELL: "off" } }),
    ).toBeUndefined();
    expect(fs.existsSync(ran)).toBe(false);
  });
});

describe("AG-0.1: agents.runtimes.<id>.bin (user.yml)", () => {
  it("wins over the search, read from the user layer", () => {
    const root = tmp();
    const onPath = claudeIn(path.join(root, "path-bin"));
    const chosen = claudeIn(path.join(root, "chosen"));
    const env = { PATH: `${path.dirname(onPath.bin)}:/usr/bin:/bin` };
    const userYml = write(
      path.join(root, "config", "local", "user.yml"),
      `agents:\n  runtimes:\n    den-claude:\n      bin: ${chosen.bin}\n`,
      0o644,
    );
    const read = () => yaml.parse(fs.readFileSync(userYml, "utf-8"));
    const setting = configuredRuntimeBin("den-claude", read);
    expect(setting).toBe(chosen.bin);
    expect(rt().detect(env, { bin: setting })).toEqual({
      available: true,
      path: chosen.bin,
      source: "setting",
      searched: [],
    });
    // Another runtime's block is not this one's.
    expect(configuredRuntimeBin("generic", read)).toBeUndefined();
  });

  it("an invalid bin is refused with its reason, never skipped for PATH", () => {
    const root = tmp();
    const onPath = claudeIn(path.join(root, "path-bin"));
    const env = { PATH: `${path.dirname(onPath.bin)}:/usr/bin:/bin` };
    const plain = write(path.join(root, "notes.txt"), "hi\n", 0o644);
    const cases: [unknown, RegExp][] = [
      [
        "bin/claude",
        /agents\.runtimes\.den-claude\.bin: "bin\/claude" is not an absolute path/,
      ],
      [
        path.join(root, "nope"),
        /agents\.runtimes\.den-claude\.bin: .*nope does not exist/,
      ],
      [
        plain,
        /agents\.runtimes\.den-claude\.bin: .*notes\.txt is not an executable file/,
      ],
      [root, /is not an executable file/],
      [
        42,
        /agents\.runtimes\.den-claude\.bin must be an absolute path \(got number\)/,
      ],
    ];
    for (const [value, why] of cases) {
      const det = rt().detect(env, { bin: value });
      expect(det.available).toBe(false);
      expect(det.why).toMatch(why);
      expect(det.path).toBeUndefined();
    }
    // A block that is no mapping says so.
    const read = () => ({
      agents: { runtimes: { "den-claude": "/x/claude" } },
    });
    expect(
      checkBinSetting("den-claude", configuredRuntimeBin("den-claude", read)),
    ).toEqual({
      why: "agents.runtimes.den-claude must be a mapping ({ bin: <absolute path> })",
    });
  });
});

describe("AG-0.2: the version", () => {
  it("runs the CLI's version command once and keeps the answer", async () => {
    const { bin, ran } = claudeIn(path.join(tmp(), "bin"), "2.3.4");
    const counter = path.join(path.dirname(bin), "count");
    // Count each --version run.
    write(
      bin,
      `#!/bin/sh\necho x >> "${counter}"\n[ "$1" = "--version" ] && { echo "2.3.4 (Claude Code)"; exit 0; }\nexit 1\n`,
    );
    expect(await runtimeVersion(bin, ["--version"], {})).toBe("2.3.4");
    expect(await runtimeVersion(bin, ["--version"], {})).toBe("2.3.4");
    expect(fs.readFileSync(counter, "utf-8").trim().split("\n")).toHaveLength(
      1,
    );
    expect(fs.existsSync(ran)).toBe(false);
  });

  it("a CLI that fails or hangs has no version (under its timeout)", async () => {
    const root = tmp();
    const bad = write(path.join(root, "bad"), "#!/bin/sh\nexit 3\n");
    const slow = write(path.join(root, "slow"), "#!/bin/sh\nexec sleep 30\n");
    expect(await runtimeVersion(bad, ["--version"], {})).toBeUndefined();
    expect(await runtimeVersion(slow, ["--version"], {}, 200)).toBeUndefined();
  });
});
