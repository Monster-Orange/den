/**
 * The GitHub budget guard in Den's PreToolUse hook (issue 487,
 * guardrails/pretooluse.mjs): an agent that polls GitHub (gh run watch at
 * its 3 s default, gh pr checks --watch, gh in a sleep loop) is blocked,
 * and the message names Den's ci_wait tool. A slow `gh run watch
 * --interval N` (N at least --gh-watch-min, default 120) still passes,
 * unless the server's budget snapshot is below the reserve or the same
 * agent already watches that run.
 *
 * Never runs the real gh: the "watcher" below is a node script named gh.
 */
import { afterAll, describe, expect, it } from "@jest/globals";
import { spawn, spawnSync, type ChildProcess } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const HOOK = path.resolve("src/shared/agents/guardrails/pretooluse.mjs");
const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-ghp-")));
const kids: ChildProcess[] = [];
afterAll(() => {
  for (const k of kids) k.kill("SIGKILL");
  fs.rmSync(dir, { recursive: true, force: true });
});

function run(
  command: string,
  opts: {
    args?: string[];
    env?: Record<string, string>;
    extra?: Record<string, unknown>;
  } = {},
): { code: number | null; stderr: string } {
  const r = spawnSync(process.execPath, [HOOK, ...(opts.args ?? [])], {
    input: JSON.stringify({
      tool_name: "Bash",
      tool_input: { command, ...(opts.extra ?? {}) },
      cwd: dir,
    }),
    encoding: "utf-8",
    env: { PATH: process.env.PATH ?? "", HOME: dir, ...(opts.env ?? {}) },
  });
  return { code: r.status, stderr: r.stderr };
}

describe("an agent polling GitHub is blocked, and told to use ci_wait", () => {
  it.each([
    "gh run watch 123",
    "gh run watch 123 --exit-status",
    "gh run watch 123 --interval 3",
    "gh run watch 123 -i 10",
    "gh -R o/r run watch 123",
    "gh pr checks 45 --watch",
    "gh pr checks --watch --interval 300",
    "while true; do gh run view 123 --json status; sleep 3; done",
    "until gh pr checks 45; do sleep 30; done",
    "for i in $(seq 1 100); do gh api repos/o/r/actions/runs/1; sleep 3; done",
  ])("blocks `%s`", (cmd) => {
    const r = run(cmd);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/ci_wait/);
  });

  it("blocks a gh sleep loop even when it runs in the background", () => {
    const r = run("while true; do gh run view 1; sleep 3; done", {
      extra: { run_in_background: true },
    });
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/ci_wait/);
  });

  it.each([
    "gh run watch 123 --interval 120 --exit-status",
    "gh run watch 123 --interval=600",
    "gh run view 123 --json status",
    "gh pr checks 45",
    "gh pr view 45",
    "echo 'gh run watch 1'",
    "for f in a b; do gh pr view $f; done",
  ])("allows `%s`", (cmd) => expect(run(cmd).code).toBe(0));

  it("the slow-watch minimum is a setting (--gh-watch-min)", () => {
    const cmd = "gh run watch 123 --interval 120";
    expect(run(cmd, { args: ["--gh-watch-min", "300"] }).code).toBe(2);
    expect(run(cmd, { args: ["--gh-watch-min", "60"] }).code).toBe(0);
    expect(
      run("gh run watch 1 -i 60", { args: ["--gh-watch-min", "60"] }).code,
    ).toBe(0);
  });
});

describe("a slow watch still counts against the reserve", () => {
  const snap = path.join(dir, "github-budget.json");
  const write = (remaining: number, resetInS: number) =>
    fs.writeFileSync(
      snap,
      JSON.stringify({
        remaining,
        limit: 5000,
        reset: Math.floor(Date.now() / 1000) + resetInS,
        reserve: 1000,
        readAt: new Date().toISOString(),
      }),
    );
  const cmd = "gh run watch 123 --interval 120 --exit-status";

  it("below the reserve, it is refused with the reason and the reset time", () => {
    write(400, 1800);
    const r = run(cmd, { args: ["--gh-budget", snap] });
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/400/);
    expect(r.stderr).toMatch(/reserve of 1000/);
    expect(r.stderr).toMatch(/resets at/);
  });

  it("above the reserve, it passes", () => {
    write(3000, 1800);
    expect(run(cmd, { args: ["--gh-budget", snap] }).code).toBe(0);
  });

  it("a snapshot from before the reset, or none at all, allows it", () => {
    write(10, -5);
    expect(run(cmd, { args: ["--gh-budget", snap] }).code).toBe(0);
    expect(
      run(cmd, { args: ["--gh-budget", path.join(dir, "none.json")] }).code,
    ).toBe(0);
  });
});

describe("one agent watches a run once", () => {
  // A stand-in for a live `gh run watch 777`: a node script named gh.
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin, { recursive: true });
  const fake = path.join(bin, "gh");
  fs.writeFileSync(fake, "setTimeout(() => {}, 60000);\n");

  async function watcher(agent: string): Promise<ChildProcess> {
    const k = spawn(process.execPath, [fake, "run", "watch", "777"], {
      env: { PATH: process.env.PATH ?? "", DEN_AGENT: `agent:${agent}` },
      stdio: "ignore",
    });
    kids.push(k);
    await new Promise((r) => setTimeout(r, 300));
    return k;
  }
  const cmd = "gh run watch 777 --interval 120 --exit-status";

  it("a second watch of the same run by the same agent is blocked", async () => {
    const k = await watcher("a1");
    const r = run(cmd, { env: { DEN_AGENT: "agent:a1" } });
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/already watch/);
    expect(r.stderr).toMatch(/ci_wait/);
    // Another agent, and another run, are not this agent's second watch.
    expect(run(cmd, { env: { DEN_AGENT: "agent:a2" } }).code).toBe(0);
    expect(
      run("gh run watch 778 --interval 120", {
        env: { DEN_AGENT: "agent:a1" },
      }).code,
    ).toBe(0);
    // When the first watch ends, the agent may watch again.
    k.kill("SIGKILL");
    await new Promise((r) => setTimeout(r, 300));
    expect(run(cmd, { env: { DEN_AGENT: "agent:a1" } }).code).toBe(0);
  });
});
