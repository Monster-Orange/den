/**
 * Den's PreToolUse hook (den#5, guardrails/pretooluse.mjs), run as Claude
 * Code runs it: the tool call as JSON on stdin; exit 2 with the reason on
 * stderr blocks it, exit 0 lets it through. It blocks whole-file reads of a
 * log or a large file and foreground sleeps, and nothing else.
 */
import { afterAll, describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const HOOK = path.resolve("src/shared/agents/guardrails/pretooluse.mjs");
const dir = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), "den-pretool-")),
);
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

// A large file that is not a log, and a small one.
fs.writeFileSync(path.join(dir, "big.txt"), "x".repeat(300 * 1024));
fs.writeFileSync(path.join(dir, "small.txt"), "hello\n");

function run(input: unknown): { code: number | null; stderr: string } {
  const r = spawnSync(process.execPath, [HOOK], {
    input: typeof input === "string" ? input : JSON.stringify(input),
    encoding: "utf-8",
    env: { PATH: process.env.PATH ?? "", HOME: dir },
  });
  return { code: r.status, stderr: r.stderr };
}
const bash = (command: string, extra: Record<string, unknown> = {}) =>
  run({ tool_name: "Bash", tool_input: { command, ...extra }, cwd: dir });
const read = (file_path: string, extra: Record<string, unknown> = {}) =>
  run({ tool_name: "Read", tool_input: { file_path, ...extra }, cwd: dir });

describe("whole-log reads are blocked, with a slice or a subagent offered", () => {
  it.each([
    "cat web.log",
    "cat logs/web.log.1",
    "cat .dev-metrics/events.jsonl",
    "cat ~/.claude/projects/x/abc.jsonl",
    "cat big.txt",
    "cd /tmp && cat web.log",
    "less web.log",
    "tail +1 web.log",
    "tail -n +1 web.log",
    "tail --lines=+1 web.log",
    "cat web.log 2>&1",
    "cat < web.log",
    "cat *.log",
  ])("blocks `%s`", (cmd) => {
    const r = bash(cmd);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/tail -n 100/);
    expect(r.stderr).toMatch(/subagent/);
  });

  it("quotes the command as typed, flags included", () => {
    expect(bash("tail -n +1 web.log").stderr).toMatch(
      /Den blocked `tail -n \+1 web\.log`/,
    );
  });

  it.each([
    "cat small.txt",
    "cat README.md",
    "cat web.log | grep ERROR",
    "cat web.log > copy.txt",
    "tail web.log",
    "tail -n 50 web.log",
    "tail -50 web.log",
    "tail -f web.log",
    "tail -F web.log",
    "tail -c 2000 web.log",
    "tail --lines=20 web.log",
    "head web.log",
    "grep -n ERROR web.log",
    "wc -l web.log",
    "echo 'cat web.log'",
    "some-cli logs | less",
  ])("allows `%s`", (cmd) => expect(bash(cmd).code).toBe(0));

  it("blocks a Read with no limit of a log or a large file", () => {
    for (const f of [
      path.join(dir, "web.log"),
      path.join(dir, ".dev-metrics", "events.jsonl"),
      path.join(dir, "big.txt"),
    ]) {
      const r = read(f);
      expect(r.code).toBe(2);
      expect(r.stderr).toMatch(/offset and limit/);
    }
    expect(read(path.join(dir, "big.txt"), { offset: 10 }).code).toBe(2);
  });

  it("allows a Read with a limit, or of a small file", () => {
    expect(read(path.join(dir, "web.log"), { limit: 100 }).code).toBe(0);
    expect(read(path.join(dir, "big.txt"), { limit: 100 }).code).toBe(0);
    expect(read(path.join(dir, "small.txt")).code).toBe(0);
  });
});

describe("polling with sleep is blocked, with background or a wait offered", () => {
  it.each([
    "sleep 30",
    "sleep 5 && curl -s localhost:3000/health",
    "until curl -s localhost:3000; do sleep 2; done",
    "while ! test -f done.txt; do sleep 1; done",
    "for i in $(seq 1 20); do make status; sleep 10; done",
    "until grep -q ready out.txt\ndo\n  sleep 3\ndone",
    "/bin/sleep 1",
  ])("blocks `%s`", (cmd) => {
    const r = bash(cmd);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/run_in_background/);
    expect(r.stderr).toMatch(/wait primitive/);
  });

  it.each([
    "echo sleep 5",
    "echo 'until x; do sleep 1; done'",
    "git commit -m 'sleep less'",
    "make test",
    "sleep 30 &",
    "cat > notes.txt <<'EOF'\nsleep 5\ncat web.log\nEOF",
  ])("allows `%s`", (cmd) => expect(bash(cmd).code).toBe(0));

  it("allows a sleep run in the background", () => {
    expect(bash("sleep 300", { run_in_background: true }).code).toBe(0);
  });
});

describe("it never blocks anything else", () => {
  it("other tools, bad input and empty input pass", () => {
    expect(
      run({ tool_name: "Edit", tool_input: { file_path: "/x/web.log" } }).code,
    ).toBe(0);
    expect(run({ tool_name: "Grep", tool_input: { pattern: "x" } }).code).toBe(
      0,
    );
    expect(run("not json").code).toBe(0);
    expect(run("").code).toBe(0);
    expect(run({ tool_name: "Bash", tool_input: {} }).code).toBe(0);
  });
});
