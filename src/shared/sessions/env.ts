/**
 * The environment a session starts with (AG spec §5a-env). The host passes
 * `env` whole (it inherits nothing), so what is built here is all a session
 * gets. There is no denylist: every session's env starts empty.
 *
 *   1. the allowlist, from the caller's env (SESSION_BASE_ENV, LC_*)
 *   2. `keep`: names the user asked for (`sessions start --keep-env NAME`;
 *      exact names, never for an agent)
 *   3. `passthrough`: names a runtime declares (Runtime.envPassthrough)
 *   4. `launch`: the runtime's launch env (LaunchOutput.env)
 *   5. `extra`: the persona's or runtime's declared env (none can declare
 *      one yet)
 *   6. `den`: Den's own markers (DEN_AGENT, and SEC-1c's DEN_ACTOR_TOKEN
 *      for an agent: the only way an actor token reaches a session; one
 *      from anywhere above is dropped first)
 *   7. then `scrub` removes every name it matches, whatever put it back:
 *      each runtime's scrubEnv (den-claude: CLAUDECODE, CLAUDE_CODE_*).
 *      Except `ownLaunch`: exact names the runtime declares its launch env
 *      sets (Runtime.launchEnv; den#3's subagent model), and only the
 *      launch env's value of them.
 *   8. and always (SEC-1 §5): a person's credential, DEN_PERSON_TOKEN or
 *      any value that is a person token or names web.secret
 *      (actor-token.ts isPersonCredentialEnv), whatever put it there.
 *
 * The session backend knows none of this: it is handed the result. Nothing
 * here logs or returns a value other than the env itself.
 */

import {
  ACTOR_TOKEN_ENV,
  ACTOR_TOKEN_FILE_ENV,
  isPersonCredentialEnv,
} from "../actor-token.js";

export const DEFAULT_TERM = "xterm-256color";

/** Set in an agent's env: `agent:<id>`, so Den's CLI run inside knows. */
export const AGENT_ACTOR_ENV = "DEN_AGENT";

/** What a terminal program needs to run as the user: no more. */
export const SESSION_BASE_ENV = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TERM",
  "COLORTERM",
  "LANG",
  "TZ",
  "TMPDIR",
] as const;

/** Whether the allowlist takes `name` (the list, and every LC_*). */
export function inSessionBase(name: string): boolean {
  return (
    (SESSION_BASE_ENV as readonly string[]).includes(name) ||
    name.startsWith("LC_")
  );
}

/** Whether a scrubEnv pattern (an exact name, or a prefix ending in *) matches. */
export function matchesScrub(
  name: string,
  patterns: readonly string[],
): boolean {
  return patterns.some((p) =>
    p.endsWith("*") ? name.startsWith(p.slice(0, -1)) : name === p,
  );
}

export interface SessionEnvInput {
  caller: NodeJS.ProcessEnv;
  keep?: readonly string[];
  passthrough?: readonly string[];
  launch?: Record<string, string>;
  extra?: Record<string, string>;
  den?: Record<string, string>;
  scrub?: readonly string[];
  /** Names `launch` may set past the scrub (Runtime.launchEnv). */
  ownLaunch?: readonly string[];
}

/** A session's environment, built as the header says. */
export function buildSessionEnv(i: SessionEnvInput): Record<string, string> {
  const named = new Set([...(i.keep ?? []), ...(i.passthrough ?? [])]);
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(i.caller))
    if (v !== undefined && (inSessionBase(k) || named.has(k))) env[k] = v;
  if (!env.TERM) env.TERM = DEFAULT_TERM;
  Object.assign(env, i.launch ?? {}, i.extra ?? {});
  delete env[ACTOR_TOKEN_ENV];
  delete env[ACTOR_TOKEN_FILE_ENV];
  Object.assign(env, i.den ?? {});
  const scrub = i.scrub ?? [];
  for (const [k, v] of Object.entries(env))
    if (matchesScrub(k, scrub) || isPersonCredentialEnv(k, v)) delete env[k];
  for (const k of i.ownLaunch ?? []) {
    const v = i.launch?.[k];
    if (v !== undefined && !isPersonCredentialEnv(k, v)) env[k] = v;
  }
  return env;
}
