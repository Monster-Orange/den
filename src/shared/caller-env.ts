/**
 * Issue 1038: what a command Den runs for its caller gets of the install
 * markers. A launcher sets DEN_ROOT, DEN_ENGINE_ROOT and DEN_INVOKE_CWD for
 * the install the CLI belongs to; a command `gate run` starts (a test run
 * in some other checkout) is the caller's, not the install's.
 *
 * bin/den records what the caller had: DEN_CALLER_ENV_SET=1, and
 * DEN_CALLER_ROOT, DEN_CALLER_ENGINE_ROOT and DEN_CALLER_INVOKE_CWD for the
 * ones that were set (one naming this Den's own install or package isn't
 * the caller's, so it isn't recorded). The record lasts one invocation:
 * the CLI takes it out of its environment as it starts (caller-env-take.ts,
 * each entry's first import), so nothing it starts (a server, a session, a
 * service, the gate's own command) inherits it, and a bin/den run later in
 * an agent's shell records afresh.
 */

/** The record's marker: bin/den has recorded the caller's markers. */
export const CALLER_ENV_SET = "DEN_CALLER_ENV_SET";

/** Each install marker, and the variable that holds the caller's own. */
export const CALLER_MARKERS = Object.freeze({
  DEN_ROOT: "DEN_CALLER_ROOT",
  DEN_ENGINE_ROOT: "DEN_CALLER_ENGINE_ROOT",
  DEN_INVOKE_CWD: "DEN_CALLER_INVOKE_CWD",
} as const);

type Marker = keyof typeof CALLER_MARKERS;

/** The caller's own value of each marker (undefined: it had none). */
export type CallerRecord = Record<Marker, string | undefined>;

const RECORD_VARS = [CALLER_ENV_SET, ...Object.values(CALLER_MARKERS)];

/** This invocation's record, once taken. */
let taken: CallerRecord | null = null;

/**
 * Reads the record from `env` and removes it (and any stray part of one).
 * Null when no launcher recorded one.
 */
export function takeCallerRecord(
  env: NodeJS.ProcessEnv = process.env,
): CallerRecord | null {
  let rec: CallerRecord | null = null;
  if (env[CALLER_ENV_SET] === "1") {
    rec = {} as CallerRecord;
    for (const [m, c] of Object.entries(CALLER_MARKERS))
      rec[m as Marker] = env[c];
  }
  for (const v of RECORD_VARS) delete env[v];
  if (env === process.env) taken = rec;
  return rec;
}

/**
 * A copy of `env` for a command run on the caller's behalf: each install
 * marker as the record has it (or gone). With no record (no launcher ran),
 * `env` is the caller's already. Never any part of a record.
 */
export function callerEnv(
  env: NodeJS.ProcessEnv,
  rec: CallerRecord | null = taken,
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  for (const v of RECORD_VARS) delete out[v];
  if (!rec) return out;
  for (const m of Object.keys(CALLER_MARKERS) as Marker[]) {
    const had = rec[m];
    if (had === undefined) delete out[m];
    else out[m] = had;
  }
  return out;
}
