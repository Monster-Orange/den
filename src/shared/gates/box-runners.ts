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
 * While a job runs, its job-started hook leaves a mark named for the
 * runner in the box's marks folder (mounted at /den-hold); the
 * job-completed hook removes that one mark, never another job's or the
 * person's hold file. The box counts as held while any mark is there.
 *
 * The types are the ones agreed with the settings side (entry fields,
 * token minting, doctor): BoxRunnerSpec, BoxRunnerToken, RunnerStatus.
 */

/** The docker label that names a container as Den's box runner. */
export const BOX_RUNNER_LABEL = "den.box-runner";
/** Where the box's marks folder is mounted inside the container. */
export const HOLD_MOUNT = "/den-hold";

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

const REPO_RE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const LABEL_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const CPUSET_RE = /^\d{1,3}(-\d{1,3})?(,\d{1,3}(-\d{1,3})?)*$/;
/** A runner id: a file name in the marks folder, and a container label. */
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export function checkSpec(
  s: BoxRunnerSpec,
): { ok: true } | { ok: false; error: string } {
  const no = (error: string) => ({ ok: false as const, error });
  if (!REPO_RE.test(s.repo ?? "")) return no("repo must be owner/name");
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
 * The job hooks for runner `id`: started leaves its mark in `holds`,
 * completed removes that mark only (and is harmless when run twice).
 */
export function hookScripts(
  id: string,
  holds: string = HOLD_MOUNT,
): { started: string; completed: string } {
  checkId(id);
  const mark = q(`${holds}/${id}`);
  return { started: `: > ${mark}`, completed: `rm -f ${mark}` };
}

/**
 * The script the container runs: the token from stdin into the runner's
 * input, the hooks, one ephemeral registration, then the runner. The
 * token is never in this text.
 */
export function runnerScript(id: string, s: BoxRunnerSpec): string {
  checkId(id);
  const h = hookScripts(id);
  return [
    "set -eu",
    "IFS= read -r t",
    'ACTIONS_RUNNER_INPUT_TOKEN="$t"',
    "unset t",
    "export ACTIONS_RUNNER_INPUT_TOKEN",
    `printf '%s\\n' ${q(h.started)} > /tmp/den-job-started.sh`,
    `printf '%s\\n' ${q(h.completed)} > /tmp/den-job-completed.sh`,
    "chmod +x /tmp/den-job-started.sh /tmp/den-job-completed.sh",
    "export ACTIONS_RUNNER_HOOK_JOB_STARTED=/tmp/den-job-started.sh",
    "export ACTIONS_RUNNER_HOOK_JOB_COMPLETED=/tmp/den-job-completed.sh",
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
  o: { image: string; marksDir: string },
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
    "-v",
    `${o.marksDir}:${HOLD_MOUNT}`,
    o.image,
    "sh",
    "-c",
    runnerScript(id, s),
  ];
}
