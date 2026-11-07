/**
 * `<cli> doctor --probe` (AG spec §5a-env): check, through the real session
 * host and backend, what environment a session actually gets. Opt-in: plain
 * `doctor` never spawns anything.
 *
 * For a plain session (as `sessions start` builds it, no --keep-env) and
 * for each available runtime's agent env (as `agents start` builds it, the
 * runtime's launch env included, but running the probe instead of the
 * runtime's CLI), it starts a short session running a tiny node script that
 * prints each key name and one flag: whether the name or value is
 * credential-shaped (secret-env.ts, with the redactor's patterns). Values
 * never leave the probe process.
 *
 * A finding is any runtime's scrubEnv name, or any credential-shaped
 * variable, in either env.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  agentSessionEnv,
  allScrubEnv,
  getRuntime,
  LaunchError,
  runtimeIds,
  type LaunchInput,
  type Runtime,
} from "../../shared/agents/runtimes.js";
import { credentialPatternData } from "../../shared/secret-env.js";
import type { HostClient } from "../../shared/sessions/client.js";
import { matchesScrub } from "../../shared/sessions/env.js";
import { sessionName } from "../../shared/sessions/names.js";
import type { PtyLoad } from "../../shared/sessions/pty.js";

const MARK = "DENPROBE";
const PROBE_ID = "env-probe";
/** How long one probe session gets to print and exit. */
const PROBE_TIMEOUT_MS = 10_000;

/** The probe: key names and a 0/1 flag per key, then an end mark. No values. */
export function probeScript(): string {
  const p = JSON.stringify(credentialPatternData());
  return [
    `const P = ${p};`,
    `const re = (l) => l.map((r) => new RegExp(r.source, r.flags));`,
    `const N = re(P.name), V = re(P.value);`,
    `for (const k of Object.keys(process.env).sort()) {`,
    `  const v = process.env[k] || "";`,
    `  const c = N.some((r) => r.test(k)) || (v !== "" && V.some((r) => r.test(v)));`,
    `  process.stdout.write("${MARK} " + k + " " + (c ? 1 : 0) + "\\n");`,
    `}`,
    `process.stdout.write("${MARK}-END\\n");`,
  ].join("\n");
}

export interface ProbeKey {
  name: string;
  credentialShaped: boolean;
}

/** The probe's report from its output; null when it did not finish. */
export function parseProbe(output: string): ProbeKey[] | null {
  const keys: ProbeKey[] = [];
  let ended = false;
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.replace(/\r/g, "").trim();
    if (line === `${MARK}-END`) ended = true;
    const m = new RegExp(`^${MARK} ([A-Za-z_][A-Za-z0-9_]*) ([01])$`).exec(
      line,
    );
    if (m) keys.push({ name: m[1], credentialShaped: m[2] === "1" });
  }
  return ended ? keys : null;
}

export interface ProbeFinding {
  key: string;
  why: string;
}

export interface ProbeResult {
  /** "plain session", or "agent (<runtime>)". */
  target: string;
  /** False: not probed (the reason says why); never a failure. */
  ran: boolean;
  reason?: string;
  keys?: number;
  findings: ProbeFinding[];
}

export interface ProbeDeps {
  dist: string;
  cli: string;
  env: NodeJS.ProcessEnv;
  pty: () => PtyLoad;
  connect: () => Promise<HostClient>;
  /** A plain session's env, as `sessions start` builds it. */
  plainEnv: (caller: NodeJS.ProcessEnv) => Record<string, string>;
  /** An agent's env, as `agents start` builds it. */
  agentEnv?: (
    caller: NodeJS.ProcessEnv,
    rt: Runtime,
    launch: Record<string, string>,
    agentId: string,
  ) => Record<string, string>;
  /** Runtimes to probe (default: every registered one that is available). */
  runtimes?: () => Runtime[];
}

/** A launch input for the probe: nothing is written, nothing it names runs. */
function probeInput(d: ProbeDeps, dir: string): LaunchInput {
  return {
    persona: {
      id: PROBE_ID,
      description: "",
      category: "engineering",
      allowedCommands: [],
      origin: "builtin",
      prompt: "",
      standing: false,
      tools: [],
      context: [],
      argv: [PROBE_ID],
      source: "doctor --probe",
    },
    workspace: { name: "doctor", dir },
    agentId: PROBE_ID,
    worktree: dir,
    mcp: { name: d.cli, command: [d.cli], env: {}, scope: "doctor" },
    // Never written: the probe uses only the launch's env.
    filesDir: path.join(dir, PROBE_ID),
    env: d.env,
  };
}

function findings(keys: ProbeKey[]): ProbeFinding[] {
  const scrub = allScrubEnv();
  const out: ProbeFinding[] = [];
  for (const k of keys) {
    if (matchesScrub(k.name, scrub))
      out.push({ key: k.name, why: "a runtime's scrubEnv name" });
    else if (k.credentialShaped)
      out.push({ key: k.name, why: "credential-shaped" });
  }
  return out;
}

/** Run the probe in one session with `env`; its report, or why not. */
async function probeOnce(
  d: ProbeDeps,
  c: HostClient,
  target: string,
  slug: string,
  env: Record<string, string>,
  cwd: string,
): Promise<ProbeResult> {
  const info = await c.start({
    name: sessionName(d.dist, "doctor", `${PROBE_ID}-${slug}`),
    cwd,
    argv: [process.execPath, "-e", probeScript()],
    env,
    cols: 200,
    rows: 24,
  });
  try {
    const deadline = Date.now() + PROBE_TIMEOUT_MS;
    for (;;) {
      const s = (await c.list()).find((x) => x.ref.id === info.ref.id);
      if (!s || s.exited) break;
      if (Date.now() > deadline) {
        await c.kill(info.ref.id, "KILL").catch(() => undefined);
        await new Promise((r) => setTimeout(r, 200));
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    const keys = parseProbe(
      (await c.scrollback(info.ref.id, 1024 * 1024)).toString("utf-8"),
    );
    if (!keys)
      return {
        target,
        ran: true,
        findings: [{ key: "-", why: "the probe did not finish" }],
      };
    return { target, ran: true, keys: keys.length, findings: findings(keys) };
  } finally {
    await c.forget(info.ref.id).catch(() => undefined);
  }
}

/** Probe a plain session and each available runtime's agent env. */
export async function runEnvProbe(d: ProbeDeps): Promise<ProbeResult[]> {
  const pty = d.pty();
  if (!pty.available)
    return [
      {
        target: "sessions",
        ran: false,
        reason: `den-pty is unavailable: ${pty.reason}`,
        findings: [],
      },
    ];
  const runtimes =
    d.runtimes?.() ??
    runtimeIds()
      .map((id) => getRuntime(id))
      .filter((rt): rt is Runtime => !!rt);
  const agentEnv = d.agentEnv ?? agentSessionEnv;
  // The probe writes nothing: its cwd is the temp dir, as it is.
  const dir = fs.realpathSync(os.tmpdir());
  const c = await d.connect();
  try {
    const out: ProbeResult[] = [
      await probeOnce(d, c, "plain session", "plain", d.plainEnv(d.env), dir),
    ];
    for (const rt of runtimes) {
      const target = `agent (${rt.id})`;
      const det = rt.detect(d.env);
      if (!det.available) {
        out.push({
          target,
          ran: false,
          reason: `${rt.id} is unavailable: ${det.why ?? "unknown"}`,
          findings: [],
        });
        continue;
      }
      let launch: Record<string, string>;
      try {
        launch = rt.launch(probeInput(d, dir)).env;
      } catch (e) {
        if (!(e instanceof LaunchError)) throw e;
        out.push({ target, ran: false, reason: e.message, findings: [] });
        continue;
      }
      out.push(
        await probeOnce(
          d,
          c,
          target,
          rt.id,
          agentEnv(d.env, rt, launch, PROBE_ID),
          dir,
        ),
      );
    }
    return out;
  } finally {
    c.close();
  }
}

/** One line per result, one per finding; key names only. */
export function formatProbe(results: ProbeResult[]): string[] {
  const lines: string[] = [];
  const width = Math.max(...results.map((r) => r.target.length));
  for (const r of results) {
    const t = r.target.padEnd(width);
    if (!r.ran)
      lines.push(`  ${t}  - not probed: ${r.reason ?? "unavailable"}`);
    else if (!r.findings.length)
      lines.push(`  ${t}  ✓ clean (${r.keys ?? 0} variables)`);
    else
      for (const f of r.findings)
        lines.push(`  ${t}  ✗ ${f.key} reaches it (${f.why})`);
  }
  return lines;
}
