/**
 * Issue 636: the test-person path. A test bed (an install that runs Den's
 * live checks against stub agents) sometimes needs the CLI to act as the
 * person from a driver that runs inside an agent-like environment: to start
 * or end a stub agent, or answer a fixture prompt.
 *
 *  - The test bed is issue 810's test install (fixture-person.ts
 *    testInstallBinding): the mark, `web.test_install: true`, set at install
 *    time (`create --test-bed`, or by hand in the distribution config; never
 *    through Settings, `config` or an agent's token), the launcher's flag,
 *    its own state dir, and no owner or paired person.
 *  - `<cli> --test-person <command>`: the CLI checks the mark, then asks the
 *    server (POST /api/web/test-person), which checks the whole binding and
 *    records the row. Only then does it drop the agent markers from its own
 *    environment and call as the person: the person token, with
 *    TEST_PERSON_HEADER on every request. Anything less: refused, and
 *    nothing runs.
 *  - The server refuses the header with any credential but the person's
 *    token, on any install that isn't a test bed, and from beyond this
 *    machine (request-guard.ts).
 *  - Every audit row made on the path carries `via: "test-person"` (auditVia):
 *    the server's, for each request that came with the header, and the
 *    CLI's own.
 */
import { AsyncLocalStorage } from "async_hooks";
import { ACTOR_TOKEN_ENV, ACTOR_TOKEN_FILE_ENV } from "./actor-token.js";
import { AGENT_ACTOR_ENV } from "./sessions/env.js";

/** The CLI's global flag. */
export const TEST_PERSON_FLAG = "--test-person";
/** The header each request on the path carries (with the person token). */
export const TEST_PERSON_HEADER = "x-den-test-person";
/** What an audit row's `via` says. */
export const TEST_PERSON_VIA = "test-person";

/** The environment names that mark a process as an agent's. */
export const AGENT_MARKER_ENV: readonly string[] = [
  AGENT_ACTOR_ENV,
  ACTOR_TOKEN_ENV,
  ACTOR_TOKEN_FILE_ENV,
];

let on = false;

/** This CLI process is on the test-person path (set once it is allowed). */
export function useTestPerson(v = true): void {
  on = v;
}

/** Whether this CLI process is on the test-person path. */
export function testPersonOn(): boolean {
  return on;
}

/** Takes the agent markers out of `env` (the CLI's own, once allowed). */
export function dropAgentMarkers(env: NodeJS.ProcessEnv): void {
  for (const k of AGENT_MARKER_ENV) delete env[k];
}

const scope = new AsyncLocalStorage<typeof TEST_PERSON_VIA>();

/** Runs `fn` as a request that came by the test-person path (the server). */
export function inTestPersonScope<T>(fn: () => T): T {
  return scope.run(TEST_PERSON_VIA, fn);
}

/** `"test-person"` for an audit row made on the path, else undefined. */
export function auditVia(): typeof TEST_PERSON_VIA | undefined {
  return scope.getStore() ?? (on ? TEST_PERSON_VIA : undefined);
}

/** Why `--test-person` is refused on an install not marked a test bed. */
export function notTestBedRefusal(configFile = "config/den.yml"): string {
  return (
    "--test-person is refused: this install isn't a test bed. A test bed is marked at install " +
    `time (create --test-bed, or web.test_install: true in ${configFile}) and started by the ` +
    "test launcher on its own state folder, with no owner. Nothing ran."
  );
}

/** Why the test-person header is refused with this credential. */
export function testPersonCredentialRefusal(): string {
  return (
    "--test-person is refused: it works only with the person's own token, from this " +
    "computer, never with an agent's token or a browser session. Nothing ran."
  );
}
