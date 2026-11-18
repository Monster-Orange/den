/**
 * Issue 456's live check (gate/456.mjs) on a fake bed: a fake Den whose
 * `agents doctor --json` asks the stub shell the gate names (DEN_LOGIN_SHELL)
 * and searches its PATH. The right Den asks the interactive shell first,
 * waits 10 s, never runs a quarantined copy and runs only the chosen copy's
 * version command. The wrong one (before the fix) takes the login shell's
 * PATH first, waits 3 s and asks every copy its version.
 * The fake harness's ctx.cli(args, { env, timeout }) sets env for that one
 * run only (DEN_* names, string values, else it throws), as the bed's does;
 * an older harness ignores the option, and the gate must say so.
 * A fake ctx (no bed, no browser), in a child node: the gate file is ESM.
 * The only files touched are the gate's own, under a temp folder.
 */
import { afterAll, describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const ROOT = path.resolve(__dirname, "../../..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "gate456-test-"));
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));
// A fake xattr (DEN_GATE_XATTR): the mark is a file beside the stub.
const XATTR = path.join(TMP, "xattr");
fs.writeFileSync(
  XATTR,
  '#!/bin/sh\ncase "$1" in\n -w) echo "$3" > "$4.quarantine";;\n -p) [ -f "$3.quarantine" ] && cat "$3.quarantine";;\n *) exit 2;;\nesac\n',
  { mode: 0o755 },
);

type Row = {
  clause: string;
  ok: boolean | null;
  skip?: string;
  detail?: string;
};

function runGate(right: boolean, oldHarness = false) {
  const evidence = path.join(
    TMP,
    `${right ? "right" : "wrong"}${oldHarness ? "-old" : ""}`,
  );
  const js = `
    const { spawnSync } = await import("child_process");
    const fs = await import("fs");
    const path = await import("path");
    const g = await import("./gate/456.mjs");
    const RIGHT = ${right}, OLD = ${oldHarness};
    const shellBefore = process.env.DEN_LOGIN_SHELL;
    const calls = [];
    const B = "__DEN_PATH_BEGIN__", E = "__DEN_PATH_END__";
    const ask = (shell, flags, ms) => {
      const r = spawnSync(shell, [flags, "printf '" + B + "%s" + E + "' \\"$PATH\\""], { encoding: "utf-8", timeout: ms });
      const m = new RegExp(B + "([^]*?)" + E).exec(r.stdout ?? "");
      return m ? m[1].split(":").filter((d) => d.startsWith("/")) : [];
    };
    const quarantined = (f) =>
      spawnSync(process.env.DEN_GATE_XATTR, ["-p", "com.apple.quarantine", f]).status === 0;
    const doctor = (env) => {
      const shell = env.DEN_LOGIN_SHELL;
      if (!shell) return JSON.stringify({ runtimes: [{ id: "codex", available: false }] });
      const ms = RIGHT ? 10000 : 3000;
      const ilc = ask(shell, "-ilc", ms), lc = ask(shell, "-lc", ms);
      const dirs = [];
      const add = (l, source) => { for (const d of l) if (!dirs.some((x) => x.dir === d)) dirs.push({ dir: d, source }); };
      if (RIGHT) { add(ilc, "interactive-shell"); add(lc, "login-shell"); }
      else { add(lc, "login-shell"); add(ilc, "interactive-shell"); }
      const copies = dirs.map((d) => ({ path: path.join(d.dir, "codex"), source: d.source }))
        .filter((c) => fs.existsSync(c.path));
      const fileVersion = (p) => /versions\\/([\\d.]+)\\//.exec(p)?.[1];
      const run = (p) => /^(\\d+\\.\\d+\\.\\d+)/.exec(spawnSync(p, ["--version"], { encoding: "utf-8" }).stdout ?? "")?.[1];
      const [c, ...rest] = copies;
      if (!RIGHT) for (const o of rest) run(o.path);
      const q = RIGHT && c && quarantined(c.path);
      const row = c ? {
        id: "codex", available: true, path: c.path, source: c.source,
        version: q ? fileVersion(c.path) : run(c.path),
        ...(q ? { quarantined: true } : {}),
        others: rest.map((o) => ({ ...o, version: fileVersion(o.path),
          ...(RIGHT && quarantined(o.path) ? { quarantined: true } : {}) })),
      } : { id: "codex", available: false };
      return JSON.stringify({ runtimes: [row] });
    };
    const ok = (body) => ({ ok: true, status: 200, json: async () => body });
    const ctx = {
      page: null,
      url: "http://bed.invalid",
      evidence: (n) => path.join(${JSON.stringify(evidence)}, n),
      evidenceDir: ${JSON.stringify(evidence)},
      api: async (p) => ok(
        p.startsWith("/api/agents/runtimes") ? [{ id: "codex", source: "PATH" }]
        : p === "/api/settings" ? (RIGHT ? { agents_shell: {} } : {}) : {}),
      cli: (args, opts) => {
        let env = {};
        if (!OLD && opts?.env !== undefined) {
          for (const [k, v] of Object.entries(opts.env))
            if (!/^DEN_[A-Z0-9_]+$/.test(k) || typeof v !== "string")
              throw new Error("ctx.cli env: " + k + " refused");
          env = { ...opts.env };
        }
        calls.push({ args, keys: Object.keys(opts?.env ?? {}).sort(), timeout: opts?.timeout ?? null, under: String(opts?.env?.DEN_LOGIN_SHELL ?? "").startsWith(${JSON.stringify(evidence)} + path.sep) });
        return args.join(" ") === "agents doctor --json"
          ? { code: 0, out: doctor(env), err: "" } : { code: 2, out: "", err: "no" };
      },
      goto: async () => {}, shot: async () => {},
    };
    let state, rows, error = null;
    try {
      state = await g.setup(ctx);
      const result = await g.run(ctx, state);
      rows = g.expect([{ cell: null, result }]);
    } catch (e) { error = String(e?.stack ?? e); }
    finally { await g.teardown(ctx, state); }
    const left = fs.existsSync(${JSON.stringify(evidence)})
      ? fs.readdirSync(${JSON.stringify(evidence)}) : [];
    const leaked = process.env.DEN_LOGIN_SHELL !== shellBefore;
    console.log(JSON.stringify({ rows, error, left, calls, leaked }));`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", js], {
    cwd: ROOT,
    encoding: "utf-8",
    timeout: 120_000,
    env: { ...process.env, DEN_GATE_XATTR: XATTR },
  });
  if (r.status !== 0) throw new Error(r.stderr || `exit ${r.status}`);
  return JSON.parse(r.stdout.trim().split("\n").pop()!) as {
    rows: Row[];
    error: string | null;
    left: string[];
    calls: {
      args: string[];
      keys: string[];
      timeout: number | null;
      under: boolean;
    }[];
    leaked: boolean;
  };
}

describe("gate/456.mjs on a fake bed", () => {
  it("the fixed Den: every clause passes, and the gate's folder is gone", () => {
    const r = runGate(true);
    expect(r.error).toBeNull();
    const ok = r.rows.map((x) => x.ok);
    expect(ok).toEqual([true, true, true, true, true]);
    expect(r.left).toEqual([]);
  }, 120_000);

  it("calls ctx.cli(args, { env, timeout }) with DEN_* string values, and never sets its own env", () => {
    const r = runGate(true);
    const call = {
      args: ["agents", "doctor", "--json"],
      keys: ["DEN_LOGIN_SHELL", "DEN_RUNTIME_DIRS"],
      timeout: expect.any(Number),
      // The stub shell is in the gate's folder under ctx.evidenceDir.
      under: true,
    };
    expect(r.calls).toEqual([call, call]);
    expect(r.leaked).toBe(false);
  }, 120_000);

  it("an older harness that ignores env: clauses 1-4 skip as needs-harness-cli-env", () => {
    const r = runGate(true, true);
    expect(r.error).toBeNull();
    expect(r.rows.slice(0, 4).map((x) => x.skip)).toEqual(
      Array(4).fill("needs-harness-cli-env"),
    );
    expect(r.left).toEqual([]);
  }, 120_000);

  it("a Den that takes the login shell first, probes every copy and waits 3 s: red", () => {
    const r = runGate(false);
    expect(r.error).toBeNull();
    expect(r.rows[0].ok).toBe(false);
    expect(r.rows[0].detail).toMatch(
      /old\/versions\/0\.30\.0\/codex \(login-shell/,
    );
    expect(r.rows[3].ok).toBe(false);
    expect(r.rows[4].ok).toBe(false);
    expect(r.rows[2].ok).toBe(false);
    expect(r.left).toEqual([]);
  }, 120_000);
});
