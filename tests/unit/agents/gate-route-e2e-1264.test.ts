/**
 * Issue 1264, end to end: Den's PreToolUse hook rewrites an agent's heavy
 * command, and the rewritten command runs through the real `gate run`
 * (bin/den) on a gate folder of its own (DEN_GATE_DIR). A fake `jest` on
 * PATH prints what it was given. It shows:
 *  1. quoting: single quotes, $(…), backticks and a heredoc reach the
 *     program byte for byte as they do without the gate (the hook passes
 *     the whole command as one single-quoted word to bash -c);
 *  2. nesting: a script that calls `gate run` itself, inside the gated
 *     run, runs in place on the held slot (issue 928), never waits on it;
 *  3. the agent's folder, its environment and the exit code carry through;
 *  4. a run that can't get a slot says so ("waiting: …") while it waits.
 */
import { afterAll, describe, expect, it } from "@jest/globals";
import { spawn, spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const HOOK = path.resolve("src/shared/agents/guardrails/pretooluse.mjs");
const CLI = path.resolve("bin/den");
const root = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), "den-route-e2e-")),
);
const gates = path.join(root, "gates");
const work = path.join(root, "work");
const bin = path.join(root, "bin");
fs.mkdirSync(gates);
fs.mkdirSync(work);
fs.mkdirSync(bin);
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

// The fake jest: its arguments, its folder, FOO, its stdin, whether it
// holds a slot; a nested `gate run` when NEST is set; exits EXIT_WITH.
fs.writeFileSync(
  path.join(bin, "jest"),
  `#!/usr/bin/env bash
for a in "$@"; do printf 'arg[%s]\\n' "$a"; done
printf 'cwd[%s]\\nfoo[%s]\\nslot[%s]\\n' "$PWD" "$FOO" "\${DEN_GATE_SLOT:+held}"
if [ ! -t 0 ]; then printf 'stdin[%s]\\n' "$(cat)"; fi
if [ -n "\${NEST:-}" ]; then "${CLI}" gate run --kind cpu -- printf 'inner ran\\n'; fi
exit "\${EXIT_WITH:-0}"
`,
  { mode: 0o755 },
);

const env = (more: Record<string, string> = {}) => ({
  PATH: `${bin}:${process.env.PATH ?? ""}`,
  HOME: process.env.HOME ?? root,
  DEN_GATE_DIR: gates,
  FOO: "bar baz",
  ...more,
});

/** The hook's rewrite of `command` (it must rewrite it). */
function rewrite(command: string): string {
  const r = spawnSync(
    process.execPath,
    [HOOK, "--gate", CLI, "--gate-settings", path.join(gates, "none.json")],
    {
      input: JSON.stringify({
        tool_name: "Bash",
        tool_input: { command },
        cwd: work,
      }),
      encoding: "utf-8",
    },
  );
  expect(r.status).toBe(0);
  return JSON.parse(r.stdout).hookSpecificOutput.updatedInput.command;
}

/** `command` run by bash in the agent's folder, as the Bash tool runs it. */
function sh(command: string, more: Record<string, string> = {}) {
  return spawnSync("bash", ["-c", command], {
    cwd: work,
    env: env(more),
    encoding: "utf-8",
    timeout: 60_000,
  });
}

/** The gate's worker flag, as the program prints it: the gate's share. */
const FLAG = /^arg\[--maxWorkers=[1-9]\d*\]\n/;

describe("issue 1264: a rewritten run behaves as the agent's own did", () => {
  it("quotes, $( ), backticks and a heredoc reach the program unchanged", () => {
    const cmd = [
      `jest 'it'"'"'s one' "$(printf 'sub %s' x)" \`printf tick\` '$HOME' <<'EOF'`,
      `heredoc $NOT_EXPANDED 'q' "dq"`,
      `EOF`,
    ].join("\n");
    const plain = sh(cmd);
    const gated = sh(rewrite(cmd));
    expect(plain.status).toBe(0);
    expect(gated.status).toBe(0);
    // The same, but for the gate's worker flag and the slot it holds.
    expect(gated.stdout).toMatch(FLAG);
    expect(gated.stdout.replace(FLAG, "")).toBe(
      plain.stdout.replace("slot[]", "slot[held]"),
    );
  }, 90_000);

  it("the agent's folder, environment and exit code carry through", () => {
    const gated = sh(rewrite("jest a.test.ts"), { EXIT_WITH: "3" });
    expect(gated.status).toBe(3);
    expect(gated.stdout).toContain(`cwd[${work}]\n`);
    expect(gated.stdout).toContain("foo[bar baz]\n");
    expect(gated.stdout).toContain("slot[held]\n");
  }, 90_000);

  it("a nested gate run inside the gated run runs in place, never waits on its own slot", () => {
    const gated = sh(rewrite("jest a.test.ts"), { NEST: "1" });
    expect(gated.status).toBe(0);
    expect(gated.stdout).toContain("inner ran\n");
  }, 90_000);

  it("with every slot taken, the run says it's waiting and who holds the slot", async () => {
    // Another run holds the one cpu slot this gate folder allows.
    fs.writeFileSync(
      path.join(gates, "settings.json"),
      JSON.stringify({ cpu_slots: 1 }),
    );
    const holder = spawn(
      CLI,
      [
        "gate",
        "run",
        "--kind",
        "cpu",
        "--label",
        "holder",
        "--",
        "bash",
        "-c",
        "read -t 60 x",
      ],
      { cwd: work, env: env(), stdio: ["pipe", "ignore", "ignore"] },
    );
    try {
      // Wait until the holder has its slot.
      for (let i = 0; i < 100; i++) {
        const s = spawnSync(CLI, ["gate", "status"], {
          env: env(),
          encoding: "utf-8",
        });
        if (/holds cpu .*"holder"/.test(s.stdout)) break;
        await new Promise((r) => setTimeout(r, 200));
      }
      const r = spawnSync("bash", ["-c", rewrite("jest a.test.ts")], {
        cwd: work,
        env: env(),
        encoding: "utf-8",
        timeout: 8_000,
      });
      expect(r.status).not.toBe(0); // timed out while waiting, never ran
      expect(r.stdout).not.toContain("arg[a.test.ts]");
      expect(`${r.stdout}${r.stderr}`).toMatch(/waiting/i);
      expect(`${r.stdout}${r.stderr}`).toContain("holder");
    } finally {
      holder.stdin?.end();
      holder.kill("SIGTERM");
      fs.rmSync(path.join(gates, "settings.json"), { force: true });
    }
  }, 90_000);
});
