import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { writeAgentLaunch } from "../../../src/shared/agents/os-user-launch-files.js";
import {
  runAgentSession,
  type AgentSessionDeps,
} from "../../../src/shared/agents/os-user-session.js";

const N = "0123456789abcdef0123456789abcdef";
let root: string;
let home: string;
let agents: string;
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "d988s-")));
  home = path.join(root, "home");
  agents = path.join(root, "agents");
  fs.mkdirSync(home);
  fs.mkdirSync(agents);
  fs.chmodSync(agents, 0o1770);
  writeAgentLaunch(agents, {
    agentId: "scout",
    argv: ["/usr/local/bin/claude", "--resume", "abc"],
    cwd: "/work/north",
    env: { DEN_AGENT: "agent:scout" },
    tokenFdEnv: "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
  });
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function deps(over: Partial<AgentSessionDeps> = {}) {
  const log: string[] = [];
  const started: {
    argv: string[];
    cwd: string;
    env: Record<string, string>;
  }[] = [];
  const d: AgentSessionDeps = {
    home,
    personUid: process.getuid!(),
    ownUid: -2,
    readToken: async (nonce) => {
      log.push(`token:${nonce}`);
      return "tok-SECRET";
    },
    makeTmp: () => {
      log.push("tmp");
      return "/t/den-abc123";
    },
    removeTmp: (dir) => {
      log.push(`rm:${dir}`);
    },
    wrap: (argv) => ({
      applied: true,
      tool: "sandbox-exec",
      argv: ["/usr/bin/sandbox-exec", "-p", "(profile)", ...argv],
      env: { DEN_AGENT_SANDBOX: "1" },
    }),
    run: async (argv, o) => {
      started.push({ argv, ...o });
      log.push("run");
      return 7;
    },
    err: (m) => log.push(`err:${m}`),
    ...over,
  };
  return { d, log, started };
}

describe("issue 988: agents session", () => {
  it("launch files, then the token, then the temp folder; the runtime starts sandboxed with the token on its fd, never in its env", async () => {
    const { d, log, started } = deps();
    await expect(runAgentSession(["scout", N], d)).resolves.toBe(7);
    expect(log).toEqual([`token:${N}`, "tmp", "run", "rm:/t/den-abc123"]);
    const s = started[0]!;
    expect(s.argv).toEqual([
      "/usr/bin/sandbox-exec",
      "-p",
      "(profile)",
      "/usr/local/bin/claude",
      "--resume",
      "abc",
    ]);
    expect(s.cwd).toBe("/work/north");
    expect(s.env).toMatchObject({
      DEN_AGENT: "agent:scout",
      DEN_AGENT_SANDBOX: "1",
      CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: "3",
      TMPDIR: "/t/den-abc123",
    });
    expect(s.argv.join(" ")).not.toContain("tok-SECRET");
  });

  it("not one id and a nonce: usage, nothing read", async () => {
    for (const args of [
      [],
      ["scout"],
      ["scout", "short"],
      ["../x", N],
      ["scout", N, "x"],
    ]) {
      const { d, log } = deps();
      await expect(runAgentSession(args, d)).resolves.toBe(64);
      expect(log.filter((l) => !l.startsWith("err:"))).toEqual([]);
    }
  });

  it("launch files that fail the check: refused before any token is asked for", async () => {
    fs.chmodSync(path.join(agents, "scout", "launch.json"), 0o660);
    const { d, log } = deps();
    await expect(runAgentSession(["scout", N], d)).resolves.toBe(65);
    expect(log.some((l) => l.startsWith("token:"))).toBe(false);
    expect(log.join("\n")).toMatch(/0660/);
  });

  it("the sandbox can't start: refused, the runtime never runs, the token never leaves", async () => {
    const { d, log, started } = deps({
      wrap: (argv) => ({
        applied: false,
        argv,
        env: {},
        reason: "sandbox-exec is missing",
      }),
    });
    await expect(runAgentSession(["scout", N], d)).resolves.toBe(65);
    expect(started).toEqual([]);
    expect(log.join("\n")).toMatch(/sandbox-exec is missing/);
    expect(log.join("\n")).not.toContain("tok-SECRET");
    expect(log).toContain("rm:/t/den-abc123");
  });

  it("no token: ends, nothing started", async () => {
    const { d, started, log } = deps({
      readToken: async () => {
        throw new Error("no token within 5 s");
      },
    });
    await expect(runAgentSession(["scout", N], d)).resolves.toBe(65);
    expect(started).toEqual([]);
    expect(log).not.toContain("tmp");
  });

  it("the runtime fails to start: the temp folder still goes", async () => {
    const { d, log } = deps({
      run: async () => {
        throw new Error("ENOENT");
      },
    });
    await expect(runAgentSession(["scout", N], d)).resolves.toBe(70);
    expect(log).toContain("rm:/t/den-abc123");
  });
});

describe("issue 988: a launch file's token env name", () => {
  it("is a plain env name, never a value", () => {
    expect(() =>
      writeAgentLaunch(agents, {
        agentId: "scout",
        argv: ["/x"],
        cwd: "/w",
        env: {},
        tokenFdEnv: "A=B",
      }),
    ).toThrow(/env name/);
  });
});
