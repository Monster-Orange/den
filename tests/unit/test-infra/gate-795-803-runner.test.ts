/**
 * Issue 866: the live checks for 795 (`gate yield`) and 803 (priority
 * classes), run as the bed runs them (runLikeBed), against this checkout's
 * own CLI. Each check works in a gate folder of its own (DEN_GATE_DIR for
 * that run only), never the machine's queue, so this is safe on any box.
 * ctx.api serves the page's word files from this checkout.
 *
 * GATE_CLI_ROOT points the CLI at another checkout (an older Den) to see a
 * check fail where the feature is missing.
 *
 * Subject (what a change to reruns it): src/ui/cli/gate-command.ts,
 * src/shared/gates/store.ts and src/shared/gates/classes.ts.
 */
import { describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const ROOT = path.resolve(__dirname, "../../..");

function runGate(issue: 795 | 803) {
  const js = `
    import { spawn } from "child_process";
    import * as fs from "fs";
    import * as path from "path";
    const g = await import("./gate/${issue}.mjs");
    const { runLikeBed } = await import("./tests/fixtures/gate-runner-like.mjs");
    const cliRoot = process.env.GATE_CLI_ROOT;
    const evidence = process.env.GATE_EVIDENCE;
    const run = (args, env, timeout) =>
      new Promise((resolve) => {
        const p = spawn(path.join(cliRoot, "bin", "den"), args, {
          cwd: cliRoot,
          env: { ...process.env, ...env, NO_COLOR: "1" },
        });
        let out = "", err = "";
        p.stdout.on("data", (d) => (out += d));
        p.stderr.on("data", (d) => (err += d));
        const t = setTimeout(() => p.kill("SIGKILL"), timeout);
        p.on("close", (code) => { clearTimeout(t); resolve({ code, out, err }); });
      });
    const ctx = {
      notes: [], log(...a) { this.notes.push(a.join(" ")); },
      async sleep(ms) { await new Promise((r) => setTimeout(r, ms)); },
      async until(fn, ms) {
        const t0 = Date.now();
        while (Date.now() - t0 < ms) {
          if (await fn()) return Date.now() - t0;
          await new Promise((r) => setTimeout(r, 500));
        }
        return null;
      },
      cli: (args, o = {}) => run(args, o.env ?? {}, o.timeout ?? 30000),
      async api(p) {
        const f = path.join("src/ui/server/public", p.replace(/^\\//, ""));
        const body = fs.existsSync(f) ? fs.readFileSync(f, "utf-8") : "";
        return new Response(body, { status: body ? 200 : 404 });
      },
      evidence: (name) => path.join(evidence, name),
    };
    const out = await runLikeBed("${issue}.mjs", g, ctx);
    console.log(JSON.stringify(out));`;
  const evidence = fs.mkdtempSync(path.join(os.tmpdir(), `gate${issue}-ev-`));
  try {
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", js], {
      cwd: ROOT,
      encoding: "utf-8",
      timeout: 170_000,
      env: {
        ...process.env,
        GATE_CLI_ROOT: process.env.GATE_CLI_ROOT || ROOT,
        GATE_EVIDENCE: evidence,
      },
    });
    const line = (r.stdout || "").trim().split("\n").pop() || "";
    try {
      return JSON.parse(line) as {
        rows?: { clause: string; ok: boolean | null; detail: string }[];
        error?: string;
      };
    } catch {
      return { error: `no result: ${(r.stderr || r.stdout || "").slice(-800)}` };
    }
  } finally {
    fs.rmSync(evidence, { recursive: true, force: true });
  }
}

const failing = (o: ReturnType<typeof runGate>) =>
  o.error ?? (o.rows ?? []).filter((x) => x.ok !== true).map((x) => `${x.clause}: ${x.detail}`);

describe("issue 866: the live checks pass on this Den", () => {
  it("795: gate yield, every clause", () => {
    const o = runGate(795);
    expect(failing(o)).toEqual([]);
    expect(o.rows).toHaveLength(4);
  }, 180_000);

  it("803: priority classes, every clause", () => {
    const o = runGate(803);
    expect(failing(o)).toEqual([]);
    expect(o.rows).toHaveLength(7);
  }, 180_000);
});
