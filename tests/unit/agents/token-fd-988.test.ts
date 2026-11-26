import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import { spawn, spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { writeAgentLaunch } from "../../../src/shared/agents/os-user-launch-files.js";
import {
  runAgentSession,
  type AgentSessionDeps,
} from "../../../src/shared/agents/os-user-session.js";
import {
  TOKEN_FD,
  spawnWithTokenFd,
} from "../../../src/shared/agents/token-fd.js";

const N = "0123456789abcdef0123456789abcdef";
const TOKEN = "tok-B-7f3c9a2e5d1b";
let root = "";
let agents = "";
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tfd-")));
  agents = path.join(root, "agents");
  fs.mkdirSync(path.join(root, "home"));
  fs.mkdirSync(agents);
  fs.chmodSync(agents, 0o2750);
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function otherProcessSees(pid: number): string {
  if (process.platform === "linux") {
    try {
      return fs.readFileSync(`/proc/${pid}/environ`, "utf8");
    } catch {
      return "";
    }
  }
  return (
    spawnSync("ps", ["-E", "-ww", "-p", String(pid), "-o", "command="], {
      encoding: "utf8",
    }).stdout ?? ""
  );
}

function probeSeesEnvironments(): boolean {
  const canary = `CANARY_${process.pid}=seen`;
  const c = spawn("/bin/sleep", ["5"], {
    env: { [canary.split("=")[0]!]: "seen" },
    stdio: "ignore",
  });
  try {
    for (let i = 0; i < 20; i++) {
      if (c.pid && otherProcessSees(c.pid).includes(canary)) return true;
      spawnSync("/bin/sleep", ["0.05"]);
    }
    return false;
  } finally {
    c.kill();
  }
}
const SEES = probeSeesEnvironments();

describe("issue 988 slice 3: a token never goes in a process's environment", () => {
  it("the session announces the token's fd in the env and hands the token over on it", async () => {
    writeAgentLaunch(agents, {
      agentId: "scout",
      argv: ["/usr/local/bin/claude"],
      cwd: "/work/north",
      env: { DEN_AGENT: "agent:scout" },
      tokenFdEnv: "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
    });
    const started: {
      argv: string[];
      env: Record<string, string>;
      secret?: string;
    }[] = [];
    const d: AgentSessionDeps = {
      home: path.join(root, "home"),
      personUid: process.getuid!(),
      ownUid: -2,
      readToken: async () => TOKEN,
      makeTmp: () => undefined,
      removeTmp: () => {},
      wrap: (argv) => ({ applied: true, argv, env: {} }),
      run: async (argv, o) => {
        started.push({ argv, env: o.env, secret: o.secret });
        return 0;
      },
      err: () => {},
      runtimeProblems: () => [],
      owed: () => [],
    };
    await expect(runAgentSession(["scout", N], d)).resolves.toBe(0);
    const s = started[0]!;
    expect(s.secret).toBe(TOKEN);
    expect(s.env.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR).toBe(
      String(TOKEN_FD),
    );
    expect(Object.values(s.env).join("\n")).not.toContain(TOKEN);
    expect(s.argv.join(" ")).not.toContain(TOKEN);
  });

  it("a launch file can't name an env var for the token itself", () => {
    expect(() =>
      writeAgentLaunch(agents, {
        agentId: "scout",
        argv: ["/usr/local/bin/claude"],
        cwd: "/work/north",
        env: {},
        tokenEnv: "CLAUDE_CODE_OAUTH_TOKEN",
      } as never),
    ).toThrow(/never goes in the environment/);
  });

  it("the runtime reads its token on the fd, and the token is nowhere in its own environment", async () => {
    const out = path.join(root, "got");
    const script = [
      'const fs = require("fs");',
      `const t = fs.readFileSync(Number(process.env.TOKEN_FD_ENV), "utf8");`,
      `const inEnv = Object.values(process.env).some((v) => v.includes(t));`,
      `fs.writeFileSync(${JSON.stringify(out)}, JSON.stringify({ t, inEnv }));`,
    ].join("\n");
    await expect(
      spawnWithTokenFd([process.execPath, "-e", script], {
        cwd: root,
        env: { PATH: process.env.PATH ?? "", TOKEN_FD_ENV: String(TOKEN_FD) },
        secret: TOKEN,
      }),
    ).resolves.toBe(0);
    expect(JSON.parse(fs.readFileSync(out, "utf8"))).toEqual({
      t: TOKEN,
      inEnv: false,
    });
  });

  (SEES ? it : it.skip)(
    `agent B's runtime gets its token on the fd; another process of the same user sees it in neither ps nor the environment${SEES ? "" : ` (skipped: ${process.platform === "darwin" ? "macOS hides other processes' environments, even from the same user" : "no process here can read another's environment"}, so the probe would prove nothing)`}`,
    async () => {
      const ready = path.join(root, "ready");
      const script = [
        'const fs = require("fs");',
        `const t = fs.readFileSync(Number(process.env.TOKEN_FD_ENV), "utf8");`,
        `const inEnv = Object.values(process.env).some((v) => v.includes(t));`,
        `fs.writeFileSync(${JSON.stringify(ready)}, JSON.stringify({ t, inEnv }));`,
        "setTimeout(() => {}, 3000);",
      ].join("\n");
      let pid = 0;
      let seen = "";
      const exit = spawnWithTokenFd([process.execPath, "-e", script], {
        cwd: root,
        env: { PATH: process.env.PATH ?? "", TOKEN_FD_ENV: String(TOKEN_FD) },
        secret: TOKEN,
        onStart: (p) => {
          pid = p;
        },
      });
      for (let i = 0; i < 200 && !fs.existsSync(ready); i++)
        await new Promise((r) => setTimeout(r, 25));
      expect(pid).toBeGreaterThan(0);
      seen = otherProcessSees(pid);
      process.kill(pid);
      await exit;
      const got = JSON.parse(fs.readFileSync(ready, "utf8"));
      expect(got).toEqual({ t: TOKEN, inEnv: false });
      expect(seen.length).toBeGreaterThan(0);
      expect(seen).toContain(`TOKEN_FD_ENV=${TOKEN_FD}`);
      expect(seen).not.toContain(TOKEN);
    },
  );
});
