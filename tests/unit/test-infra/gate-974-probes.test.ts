import { afterAll, describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  DEFAULT_ENV_HOLD,
  envHoldScript,
  envMaskArgs,
} from "../../../src/shared/agents/env-hold.js";
import { readAgentsConfig } from "../../../src/shared/den-config.js";

const ROOT = path.resolve(__dirname, "../../..");
const HOOK = path.join(ROOT, "src/shared/agents/guardrails/pretooluse.mjs");
const tmp = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), "den-gate-974-")),
);
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const q = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;

function agentFiles(name: string, opts: { hook?: boolean } = {}): string {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "env-hold.sh"),
    envHoldScript(DEFAULT_ENV_HOLD),
  );
  const args = envMaskArgs(
    readAgentsConfig(
      { agents: {} } as never,
      {
        agents: { env_hold: [...DEFAULT_ENV_HOLD] },
      } as never,
    ).envHold!,
  );
  const command = [process.execPath, HOOK, "--no-guardrails", ...args]
    .map(q)
    .join(" ");
  const allow = Array.from({ length: 80 }, (_, i) => `Bash(tool-${i} *)`);
  fs.writeFileSync(
    path.join(dir, "settings.json"),
    JSON.stringify(
      {
        permissions: { allow },
        hooks:
          opts.hook === false
            ? {}
            : {
                PreToolUse: [
                  {
                    matcher: "Bash|Read",
                    hooks: [{ type: "command", command }],
                  },
                ],
              },
      },
      null,
      2,
    ),
  );
  return dir;
}

type Row = {
  clause: string;
  ok: boolean | null;
  skip?: string;
  detail: string;
};
type Run = {
  rows?: Row[];
  error?: string;
  sent: string[];
  refused: string[];
};

function runGate(
  dir: string,
  mode: "stub" | "silent" | "cut" | "noprofile" = "stub",
): Run {
  const js = `
    import { spawnSync } from "node:child_process";
    const g = await import("./gate/974.mjs");
    const { runLikeBed } = await import("./tests/fixtures/gate-runner-like.mjs");
    const dir = ${JSON.stringify(dir)};
    const mode = ${JSON.stringify(mode)};
    const sent = [];
    const refused = [];
    const env = {
      PATH: "/usr/bin:/bin",
      HOME: dir,
      TMPDIR: dir,
      CLAUDE_ENV_FILE: dir + "/env-hold.sh",
    };
    const sh = async (cmd) => {
      sent.push(cmd);
      if (mode === "silent") return { status: null, out: "", err: "no /sh result" };
      if (mode === "noprofile" && cmd.includes("g974-profile")) return { status: null, out: "", err: "no /sh result" };
      if (/\\n/.test(cmd)) {
        refused.push(cmd.split("\\n")[0]);
        return { status: null, out: "", err: "no /sh result within 15000 ms" };
      }
      const r = spawnSync("/bin/sh", ["-c", cmd], { encoding: "utf-8", env });
      const res = { status: r.status, out: (r.stdout || "").slice(0, 1500), err: (r.stderr || "").slice(0, 1500) };
      return mode === "cut" ? { ...res, cut: { out: 99999 } } : res;
    };
    const agent = () => ({
      start: () => ({ code: 0 }),
      running: async () => 1,
      sh,
      state: () => null,
      remove: () => {},
    });
    const ctx = { agent };
    process.env.PATH = "/usr/bin:/bin";
    const r = await runLikeBed("974.mjs", g, ctx);
    process.stdout.write(JSON.stringify({ ...r, sent, refused }));
  `;
  const p = spawnSync(process.execPath, ["--input-type=module", "-e", js], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, DEN_ROOT: ROOT },
    timeout: 60000,
  });
  if (p.status !== 0) throw new Error(p.stderr);
  return JSON.parse(p.stdout) as Run;
}

const row = (r: Run, i: number) => r.rows?.[i];

describe("issue 974's live check against the stub's limits", () => {
  const good = runGate(agentFiles("held"));

  it("sends every /sh as one line", () => {
    expect(good.refused).toEqual([]);
    expect(good.sent.length).toBeGreaterThan(0);
  });

  it("the hold clause passes: the profile's canary is gone with env-hold.sh", () => {
    expect(good.error).toBeUndefined();
    expect(row(good, 0)?.ok).toBe(true);
    expect(row(good, 0)?.detail).toMatch(
      /without the file: seen, with it: gone/,
    );
  });

  it("the guard clause passes with a settings.json longer than the cut", () => {
    expect(
      fs.statSync(path.join(tmp, "held", "settings.json")).size,
    ).toBeGreaterThan(1500);
    expect(row(good, 2)?.ok).toBe(true);
    expect(row(good, 2)?.detail).toMatch(
      /env: exit 0, masked, name shown, value never seen/,
    );
  });

  it("the other clauses skip by name", () => {
    expect(row(good, 1)?.skip).toBe("needs-config-change");
    expect(row(good, 3)?.skip).toBe("needs-claude");
    expect(row(good, 4)?.skip).toBe("needs-personal-install");
  });

  it("a settings.json with no pretooluse hook fails the guard clause", () => {
    const r = runGate(agentFiles("nohook", { hook: false }));
    expect(r.error).toBeUndefined();
    expect(row(r, 2)?.ok).toBe(false);
    expect(row(r, 2)?.detail).toMatch(/no PreToolUse hook/);
  });

  it("a /sh that never answers is an ERROR that says not measured, never a FAIL", () => {
    const r = runGate(agentFiles("silent"), "silent");
    expect(r.rows).toBeUndefined();
    expect(r.error).toMatch(/974 not measured: CLAUDE_ENV_FILE/);
  });
});

describe("Vision's three rules for the check", () => {
  it("(a) a multi-line /sh is refused before it is sent", () => {
    const js = `
      const g = await import("./gate/974.mjs");
      let calls = 0;
      const a = { sh: async () => { calls++; return { status: 0, out: "" }; } };
      let error = null;
      try { await g.oneLine(a, "echo a\\necho b", 1000); } catch (e) { error = String(e.message); }
      process.stdout.write(JSON.stringify({ calls, error }));
    `;
    const p = spawnSync(process.execPath, ["--input-type=module", "-e", js], {
      cwd: ROOT,
      encoding: "utf8",
    });
    expect(JSON.parse(p.stdout)).toEqual({
      calls: 0,
      error: expect.stringMatching(/refused a multi-line \/sh command/),
    });
  });

  it("(b) output the bed marks as cut is said as such and never parsed", () => {
    const r = runGate(agentFiles("cut"), "cut");
    expect(r.rows).toBeUndefined();
    expect(r.error).toMatch(
      /974 not measured: CLAUDE_ENV_FILE \(output cut short\)/,
    );
  });

  it('(c) a probe with no value is an ERROR naming it, never "still there"', () => {
    const r = runGate(agentFiles("noprofile"), "noprofile");
    expect(r.rows).toBeUndefined();
    expect(r.error).toMatch(/974 not measured: the profile canary/);
    expect(r.error).not.toMatch(/still there/);
  });
});

describe("no gate sends a multi-line command to an agent's /sh", () => {
  const calls = (src: string) => {
    const out: { line: number; text: string }[] = [];
    let i = 0;
    while ((i = src.indexOf(".sh(", i)) >= 0) {
      let depth = 0;
      let quote: string | null = null;
      let j = i + 3;
      for (; j < src.length; j++) {
        const c = src[j];
        if (quote) {
          if (c === "\\") j++;
          else if (c === quote) quote = null;
          continue;
        }
        if (c === '"' || c === "'" || c === "`") quote = c;
        else if (c === "(") depth++;
        else if (c === ")" && --depth === 0) break;
      }
      out.push({
        line: src.slice(0, i).split("\n").length,
        text: src.slice(i, j + 1),
      });
      i = j;
    }
    return out;
  };

  it("finds the calls", () => {
    const src = fs.readFileSync(path.join(ROOT, "gate/732.mjs"), "utf8");
    expect(calls(src).length).toBeGreaterThan(0);
  });

  it("no .sh( call joins lines", () => {
    const bad: string[] = [];
    for (const f of fs
      .readdirSync(path.join(ROOT, "gate"))
      .filter((f) => /^\d+\.mjs$/.test(f))) {
      const src = fs.readFileSync(path.join(ROOT, "gate", f), "utf8");
      for (const c of calls(src))
        if (/\.join\(\s*["'`]\\n["'`]\s*\)/.test(c.text))
          bad.push(`gate/${f}:${c.line}`);
    }
    expect(bad).toEqual([]);
  });
});
