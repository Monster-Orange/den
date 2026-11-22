/**
 * Issue 1038: what a command Den runs for its caller gets of the install
 * markers. A launcher sets DEN_ROOT, DEN_ENGINE_ROOT and DEN_INVOKE_CWD for
 * the install the CLI belongs to; a command `gate run` starts (a test run
 * in some other checkout) is the caller's, not the install's. bin/den, the
 * first time it runs in a chain, records what the caller had:
 * DEN_CALLER_ENV_SET=1, and DEN_CALLER_ROOT, DEN_CALLER_ENGINE_ROOT and
 * DEN_CALLER_INVOKE_CWD for the ones that were set (a DEN_ROOT naming the
 * distribution this Den is installed in was that distribution's launcher's,
 * so it isn't recorded).
 */

/** The record's marker: bin/den has recorded the caller's markers. */
export const CALLER_ENV_SET = "DEN_CALLER_ENV_SET";

/** Each install marker, and the variable that holds the caller's own. */
export const CALLER_MARKERS = Object.freeze({
  DEN_ROOT: "DEN_CALLER_ROOT",
  DEN_ENGINE_ROOT: "DEN_CALLER_ENGINE_ROOT",
  DEN_INVOKE_CWD: "DEN_CALLER_INVOKE_CWD",
} as const);

/**
 * A copy of `env` for a command run on the caller's behalf: each install
 * marker as the caller had it (or gone), and the record gone. With no
 * record (no launcher ran), `env` is the caller's already: a copy as it is.
 */
export function callerEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  if (out[CALLER_ENV_SET] !== "1") return out;
  for (const [marker, caller] of Object.entries(CALLER_MARKERS)) {
    const had = out[caller];
    if (had === undefined) delete out[marker];
    else out[marker] = had;
    delete out[caller];
  }
  delete out[CALLER_ENV_SET];
  return out;
}
