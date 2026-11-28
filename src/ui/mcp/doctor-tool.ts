/**
 * Issue 329: `doctor`, a read-only MCP tool for the server agent. It runs
 * `<cli> doctor --json` (never --probe: that starts sessions) and answers
 * every check, the passing ones too, with a count per status. The answer
 * goes through the redactor like every tool's (runTool). Only the person's
 * CLI and this install's own server agent (an unscoped server) run it; a
 * project agent's scoped server is refused before anything runs.
 */
import { spawn } from "child_process";
import { Refusal } from "./guards.js";
import { ScopeRefusal } from "./scope.js";
import type { DenTool, ToolContext } from "./tools.js";

/** How `doctor` runs: args after the CLI, its exit code and its output. */
export type DoctorRun = (
  args: string[],
) => Promise<{ code: number; out: string }>;

/**
 * Doctor's own checks can wait on the network (Hub, GitHub, the edge);
 * a backstop only, so a stuck check can't hold the agent's call forever.
 */
const DOCTOR_BACKSTOP_MS = 5 * 60_000;

/** The real run: this install's CLI, as the web server runs it for updates. */
const defaultRun: DoctorRun = async (args) => {
  const { denCliCommand } = await import("../cli/web-command.js");
  const cli = denCliCommand();
  return new Promise((resolve) => {
    let out = "";
    const child = spawn(cli.cmd, [...cli.baseArgs, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, NO_COLOR: "1" },
    });
    const stop = setTimeout(() => child.kill("SIGTERM"), DOCTOR_BACKSTOP_MS);
    child.stdout.on("data", (b: Buffer) => (out += b.toString("utf-8")));
    child.stderr.on("data", (b: Buffer) => (out += b.toString("utf-8")));
    child.on("error", (e) => {
      clearTimeout(stop);
      resolve({ code: 127, out: `${out}${e.message}` });
    });
    child.on("close", (code) => {
      clearTimeout(stop);
      resolve({ code: code ?? 1, out });
    });
  });
};

interface Check {
  id?: unknown;
  status?: unknown;
}

/** The JSON report in doctor's output (it may print a line before it). */
function reportOf(out: string): { ok?: unknown; checks: Check[] } | null {
  const at = out.indexOf("{");
  if (at < 0) return null;
  try {
    const j = JSON.parse(out.slice(at)) as { checks?: unknown };
    return Array.isArray(j?.checks)
      ? (j as { ok?: unknown; checks: Check[] })
      : null;
  } catch {
    return null;
  }
}

export const doctorTool: DenTool = {
  name: "doctor",
  title: "Run doctor",
  description:
    "Issue 329: run this Den's doctor now (`<cli> doctor --json`, read-only; never --probe) and get every check, the passing ones too: `checks` ({ id, status ok|info|warn|fail, detail, fix }), `counts` per status and `ok`. Secrets are redacted. A failing check is doctor's answer, not an error. Only the person and this install's own server agent may run it; a project agent is refused, so it asks the server agent.",
  action: false,
  shape: {},
  run: async (_a, ctx: ToolContext) => {
    if (ctx.scope)
      throw new ScopeRefusal(
        `doctor: doctor is run by the person who runs this install, or by this install's own server agent; ${ctx.scope.actor} (project "${ctx.scope.workspace}") is neither. Ask the server agent.`,
      );
    const r = await (ctx.doctor ?? defaultRun)(["doctor", "--json"]);
    const rep = reportOf(r.out);
    if (!rep)
      throw new Refusal(
        `doctor: it printed no report (exit ${r.code}): ${r.out.trim().split("\n").slice(-5).join(" | ").slice(-600)}`,
      );
    const counts: Record<string, number> = {};
    for (const c of rep.checks) {
      const s = typeof c.status === "string" ? c.status : "?";
      counts[s] = (counts[s] ?? 0) + 1;
    }
    return { ...rep, counts };
  },
};
