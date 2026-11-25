/**
 * Issue 921, box side: what Den runs on a test box for one queued CI job.
 *
 * One fresh runner container per job (`docker run --rm -i`, an ephemeral
 * runner), started under a gate slot. Its CPU and memory caps are set once
 * at `docker run` and Den never runs `docker update` on a container with
 * BOX_RUNNER_LABEL, so the cap it started with is the cap it keeps.
 *
 * The registration token reaches the container on its stdin only: never
 * in argv, an env file, the script text, logs or errors. The script reads
 * it into the runner's own input variable and drops it.
 *
 * While a runner's container runs, the box's own shell keeps a mark named
 * for the runner in the box's marks folder: made just before `docker run`,
 * removed when it ends, never another runner's or the person's hold file.
 * The box counts as held while any mark is there. Nothing of the box is
 * mounted into the container, so a job can't forge or remove a mark
 * (issue 921 review).
 *
 * The types are the ones agreed with the settings side (entry fields,
 * token minting, doctor): BoxRunnerSpec, BoxRunnerToken, RunnerStatus.
 */

import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { writeFileAtomic } from "../atomic-write.js";
import { marksDirOf, type GateBox } from "./boxes.js";
import { isRepoName } from "../repo-name.js";

export { marksDirOf };

/** The docker label that names a container as Den's box runner. */
export const BOX_RUNNER_LABEL = "den.box-runner";

export interface BoxRunnerSpec {
  project: string;
  box: string;
  /** owner/name */
  repo: string;
  /** The runs-on labels the runner registers with. */
  labels: string[];
  cpus: number;
  /** docker's --cpuset-cpus, e.g. "0-3" or "0,2,4". */
  cpuset?: string;
  memoryMb: number;
  slot: { id: string; kind: "cpu" | "browser" };
}

export interface BoxRunnerToken {
  value: string;
  expiresAt: string;
}

export interface RunnerStatus {
  id: string;
  project: string;
  repo: string;
  box: string;
  job?: { id: string; name: string; runUrl?: string };
  cpus: number;
  cpuset?: string;
  memoryMb: number;
  startedAt: string;
  endedAt?: string;
  state: "starting" | "idle" | "running" | "done" | "failed";
  hold: boolean;
  error?: string;
}

export const BOX_RUNNER_LIMITS = {
  cpus: [1, 64],
  memoryMb: [512, 262_144],
} as const;

const LABEL_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const CPUSET_RE = /^\d{1,3}(-\d{1,3})?(,\d{1,3}(-\d{1,3})?)*$/;
/** A runner id: a file name in the marks folder, and a container label. */
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export function checkSpec(
  s: BoxRunnerSpec,
): { ok: true } | { ok: false; error: string } {
  const no = (error: string) => ({ ok: false as const, error });
  if (!isRepoName(s.repo)) return no("repo must be owner/name");
  if (!s.project) return no("project is required");
  if (!s.box) return no("box is required");
  if (!Array.isArray(s.labels) || !s.labels.length)
    return no("labels: at least one runner label");
  for (const l of s.labels)
    if (!LABEL_RE.test(l)) return no(`labels: "${l}" is not a runner label`);
  const [cLo, cHi] = BOX_RUNNER_LIMITS.cpus;
  if (!Number.isInteger(s.cpus) || s.cpus < cLo || s.cpus > cHi)
    return no(`cpus must be a whole number from ${cLo} to ${cHi}`);
  if (s.cpuset !== undefined && !CPUSET_RE.test(s.cpuset))
    return no('cpuset must look like "0-3" or "0,2,4"');
  const [mLo, mHi] = BOX_RUNNER_LIMITS.memoryMb;
  if (!Number.isInteger(s.memoryMb) || s.memoryMb < mLo || s.memoryMb > mHi)
    return no(`memoryMb must be a whole number from ${mLo} to ${mHi}`);
  if (!s.slot?.id || (s.slot.kind !== "cpu" && s.slot.kind !== "browser"))
    return no("slot: a gate slot id and kind (cpu or browser)");
  return { ok: true };
}

function checkId(id: string): void {
  if (!ID_RE.test(id))
    throw new Error(`not a runner id: ${JSON.stringify(id)}`);
}

/** One shell word, single-quoted. */
const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * The script the container runs: the token from stdin into the runner's
 * input, one ephemeral registration, then the runner. The token is never
 * in this text.
 */
export function runnerScript(id: string, s: BoxRunnerSpec): string {
  checkId(id);
  return [
    "set -eu",
    "IFS= read -r t",
    'ACTIONS_RUNNER_INPUT_TOKEN="$t"',
    "unset t",
    "export ACTIONS_RUNNER_INPUT_TOKEN",
    [
      "./config.sh",
      "--url",
      q(`https://github.com/${s.repo}`),
      "--name",
      q(`den-${s.box}-${id}`),
      "--labels",
      q(s.labels.join(",")),
      "--ephemeral",
      "--unattended",
      "--disableupdate",
    ].join(" "),
    "unset ACTIONS_RUNNER_INPUT_TOKEN",
    "exec ./run.sh",
  ].join("\n");
}

/**
 * The box's `docker run` argv for runner `id`. `--rm -i`: the container
 * goes when the job's runner exits, and its stdin carries the token.
 */
export function runnerArgs(
  s: BoxRunnerSpec,
  id: string,
  o: { image: string },
): string[] {
  checkId(id);
  return [
    "docker",
    "run",
    "--rm",
    "-i",
    "--name",
    `den-runner-${id}`,
    "--label",
    `${BOX_RUNNER_LABEL}=${id}`,
    "--label",
    `den.box-project=${s.project}`,
    "--cpus",
    String(s.cpus),
    ...(s.cpuset ? ["--cpuset-cpus", s.cpuset] : []),
    "--memory",
    `${s.memoryMb}m`,
    o.image,
    "sh",
    "-c",
    runnerScript(id, s),
  ];
}

/** What startBoxRunner needs; tests pass a scripted process starter. */
export interface BoxRunnerDeps {
  start?: typeof spawn;
  /** Where each runner's status file is kept (one JSON file per runner). */
  stateDir: string;
  /** The runner image the box pulls. */
  image: string;
  newId?: () => string;
  now?: () => Date;
}

/** ssh to the box, keys only, then the one remote line. */
function sshArgs(box: GateBox, line: string): string[] {
  return [
    "-T",
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=10",
    ...(box.ssh_port ? ["-p", String(box.ssh_port)] : []),
    ...(box.ssh_identity ? ["-i", box.ssh_identity] : []),
    "--",
    box.ssh!,
    line,
  ];
}

/**
 * The line the box runs: make the marks folder, leave this runner's mark,
 * run its container, then remove the mark (a failed run too) and exit
 * with docker's code. Every word is quoted.
 */
export function remoteLine(
  s: BoxRunnerSpec,
  id: string,
  o: { image: string; marksDir: string },
): string {
  checkId(id);
  const words = runnerArgs(s, id, { image: o.image }).map(q);
  const dir = q(o.marksDir);
  const mark = `"$D"/${q(id)}`;
  return (
    `D=$(mkdir -p -- ${dir} && cd -- ${dir} && pwd) && : > ${mark} && ` +
    `{ ${words.join(" ")}; r=$?; rm -f -- ${mark}; exit $r; }`
  );
}

const newRunnerId = () =>
  `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

function statusFile(dir: string, id: string): string {
  return path.join(dir, `${id}.json`);
}

function saveStatus(dir: string, st: RunnerStatus): void {
  fs.mkdirSync(dir, { recursive: true });
  writeFileAtomic(statusFile(dir, st.id), JSON.stringify(st, null, 2) + "\n");
}

/** One process; resolves with its exit code and the end of its stderr. */
function runSsh(
  start: typeof spawn,
  box: GateBox,
  line: string,
  stdin: string,
): Promise<{ code: number | null; err: string; failed?: string }> {
  return new Promise((resolve) => {
    let err = "";
    let settled = false;
    const finish = (v: {
      code: number | null;
      err: string;
      failed?: string;
    }) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    const k = start("ssh", sshArgs(box, line), {
      stdio: ["pipe", "ignore", "pipe"],
    });
    k.stderr?.on("data", (d: Buffer) => {
      err = (err + d.toString("utf-8")).slice(-4096);
    });
    k.on("error", (e: Error) => finish({ code: null, err, failed: e.message }));
    k.on("close", (code: number | null) => finish({ code, err }));
    k.stdin?.end(stdin);
  });
}

/**
 * Start one ephemeral runner on the box for one queued job, under the
 * job's gate slot. The token goes to ssh's stdin, which reaches the
 * container's: it is never in argv, a file, the status or an error.
 * When the runner exits (after its one job), the status says done or
 * failed, and Den removes the runner's own mark again, in case the
 * box's line was cut off (ssh dropped) before it could.
 */
export function startBoxRunner(
  box: GateBox,
  s: BoxRunnerSpec,
  token: BoxRunnerToken,
  deps: BoxRunnerDeps,
):
  | { ok: true; runner: RunnerStatus; done: Promise<RunnerStatus> }
  | { ok: false; error: string } {
  const c = checkSpec(s);
  if (!c.ok) return c;
  if (!box?.ssh)
    return {
      ok: false,
      error: "the box has no ssh: Den can't start a runner on it",
    };
  if (box.name !== s.box)
    return { ok: false, error: `the spec names box ${s.box}, not ${box.name}` };
  const now = deps.now ?? (() => new Date());
  const v = token?.value;
  if (typeof v !== "string" || !v || /[\s]/.test(v))
    return { ok: false, error: "the runner token is empty or not one word" };
  const exp = Date.parse(token.expiresAt);
  if (!Number.isFinite(exp) || exp <= now().getTime())
    return { ok: false, error: "the runner token has expired" };
  const start = deps.start ?? spawn;
  const id = (deps.newId ?? newRunnerId)();
  checkId(id);
  const marksDir = marksDirOf(box);
  const st: RunnerStatus = {
    id,
    project: s.project,
    repo: s.repo,
    box: s.box,
    cpus: s.cpus,
    ...(s.cpuset ? { cpuset: s.cpuset } : {}),
    memoryMb: s.memoryMb,
    startedAt: now().toISOString(),
    state: "starting",
    hold: false,
  };
  saveStatus(deps.stateDir, st);
  const blank = (t: string) => t.split(v).join("[token]");
  const done = runSsh(
    start,
    box,
    remoteLine(s, id, { image: deps.image, marksDir }),
    `${v}\n`,
  ).then(async (r) => {
    const last =
      r.failed ??
      r.err
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .pop();
    const end: RunnerStatus = {
      ...st,
      endedAt: now().toISOString(),
      state: r.code === 0 ? "done" : "failed",
      hold: false,
      ...(r.code === 0
        ? {}
        : { error: blank(last || `ssh exited ${r.code}`).slice(0, 300) }),
    };
    saveStatus(deps.stateDir, end);
    // Its own mark only; harmless when the hook already removed it.
    await runSsh(start, box, `rm -f -- ${q(`${marksDir}/${id}`)}`, "");
    return end;
  });
  return { ok: true, runner: st, done };
}

/** A runner that has started but isn't in docker ps yet is left alone this long. */
const LIVE_GRACE_MS = 60_000;

/**
 * The runners Den started, from their status files, one project's or all.
 * With `live` (the ids docker ps lists on the boxes), a runner still
 * marked as going whose container is gone is failed.
 */
export function listBoxRunners(
  project: string | undefined,
  o: { stateDir: string; live?: Set<string>; now?: () => Date },
): RunnerStatus[] {
  let names: string[];
  try {
    names = fs.readdirSync(o.stateDir).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const now = (o.now ?? (() => new Date()))().getTime();
  const out: RunnerStatus[] = [];
  for (const f of names.sort()) {
    let st: RunnerStatus;
    try {
      st = JSON.parse(fs.readFileSync(path.join(o.stateDir, f), "utf-8"));
    } catch {
      continue;
    }
    if (!st || typeof st.id !== "string" || !ID_RE.test(st.id)) continue;
    if (project && st.project !== project) continue;
    const going =
      st.state === "starting" || st.state === "idle" || st.state === "running";
    const age = now - Date.parse(st.startedAt);
    if (o.live && going && !o.live.has(st.id) && !(age < LIVE_GRACE_MS)) {
      st = {
        ...st,
        state: "failed",
        hold: false,
        endedAt: new Date(now).toISOString(),
        error: "its container is gone",
      };
      saveStatus(o.stateDir, st);
    }
    out.push(st);
  }
  return out;
}

/** The box's command that lists Den's running box runners, one id a line. */
export function dockerPsArgs(): string[] {
  return [
    "docker",
    "ps",
    "--filter",
    `label=${BOX_RUNNER_LABEL}`,
    "--format",
    `{{.Label "${BOX_RUNNER_LABEL}"}}`,
  ];
}

/** The runner ids in dockerPsArgs' output. */
export function liveRunnerIds(out: string): Set<string> {
  return new Set(
    out
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => ID_RE.test(l)),
  );
}
