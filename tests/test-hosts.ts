/**
 * Issue 501: the one way a test starts a session host in a process of its
 * own, owns it and stops it, even when the test fails or times out.
 *
 * - `startTestHost(script, stateDir)` runs a helper host script
 *   (tests/unit/sessions/helpers/*-host.ts) tagged with this run, this file
 *   and an owner of its own (tests/test-hosts-core.cjs). setup.ts stops it after
 *   the test that started it (afterEach), or after the file when a hook
 *   started it (afterAll).
 * - `ownHosts(env)` is for a Den CLI a test runs that starts a host on its
 *   own (`sessions start`): the env carries an owner's tag, and the hosts it
 *   leads to are stopped the same way.
 * - A Den server started with tests/child-servers.ts owns the hosts it
 *   starts: `stopServer` stops them with it.
 *
 * Global teardown fails the run for any host of the run still alive, naming
 * the test file it came from.
 */
import { spawn, type ChildProcess, type SpawnOptions } from "child_process";
import { randomBytes } from "crypto";
import * as path from "path";

export interface TaggedHost {
  pid: number;
  pgid: number;
  run: string;
  file: string | null;
  owner: string | null;
  command: string;
}

interface Core {
  hostTag(run: string | number, file?: string, owner?: string): string;
  taggedHosts(want: {
    run: string;
    file?: string | null;
    owner?: string | null;
  }): TaggedHost[];
  stopHosts(hosts: TaggedHost[], graceMs?: number): Promise<void>;
}
// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
const core = require("./test-hosts-core.cjs") as Core;

export const hostTag = core.hostTag;
export const taggedHosts = core.taggedHosts;
export const stopHosts = core.stopHosts;

const CURRENT_FILE = Symbol.for("den.test.currentFile");
/**
 * The one child_process module of this worker: every test file's spawns
 * go through it, so it holds which file runs now (one jest module registry
 * per file, but core modules are shared).
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
const shared = require("child_process") as Record<symbol, unknown>;

/** Issue 501: the test file running now in this worker (setup.ts sets it). */
export function setCurrentTestFile(file: string): void {
  shared[CURRENT_FILE] = file;
  // And Den code the test runs in this process starts its hosts with it
  // (sessions-command.ts reads DEN_HOST_TAG from its own env).
  const tag = tagFor();
  if (tag) process.env.DEN_HOST_TAG = tag;
}

/** The test file running now, relative to the checkout, or undefined. */
export function currentTestFile(): string | undefined {
  const f = shared[CURRENT_FILE];
  return typeof f === "string" ? f : undefined;
}

/** This run's id (global setup), or null outside a jest run. */
export function testRun(): string | null {
  return process.env.DEN_TEST_RUN || null;
}

/**
 * The tag for a host a spawn leads to: this run and the file running now;
 * `owner` when a helper owns it. Null outside a jest run.
 */
export function tagFor(owner?: string): string | null {
  const run = testRun();
  return run ? hostTag(run, currentTestFile(), owner) : null;
}

/** A new owner's id. */
export function newOwner(): string {
  return `o${randomBytes(6).toString("hex")}`;
}

/** Stop the live hosts tagged with this run and `owner`. */
export async function stopOwned(owner: string, graceMs = 5_000): Promise<void> {
  const run = testRun();
  if (!run) return;
  const hosts = taggedHosts({ run, owner });
  if (hosts.length) await stopHosts(hosts, graceMs);
}

/** Owners setup.ts stops: `inTest` ones after their test, the rest after the file. */
const owners: { stop: () => Promise<void>; inTest: boolean }[] = [];

function own(stop: () => Promise<void>): void {
  owners.push({ stop, inTest: inTest() });
}

let testRunning = false;

/** Whether a test (or its beforeEach) runs now; not in a beforeAll. */
function inTest(): boolean {
  return testRunning;
}

/** setup.ts: a test begins (root beforeEach), or has ended (root afterEach). */
export function markTest(running: boolean): void {
  testRunning = running;
}

/**
 * setup.ts: stop the hosts owned since the test began (`scope: "test"`), or
 * every host this file owns (`scope: "file"`).
 */
export async function stopOwnedHosts(scope: "test" | "file"): Promise<void> {
  const pick = owners.filter((o) => scope === "file" || o.inTest);
  for (const o of pick) owners.splice(owners.indexOf(o), 1);
  // Together: each waits up to its grace, inside a hook's own timeout.
  await Promise.all(pick.map((o) => o.stop()));
}

/**
 * `env` for a Den CLI or server that may start a host: tagged with an owner
 * that is stopped after this test (or this file, from a hook). Returns the
 * env and a stop function for a test that stops them sooner.
 */
export function ownHosts(env: NodeJS.ProcessEnv = process.env): {
  env: NodeJS.ProcessEnv;
  stop: () => Promise<void>;
} {
  const owner = newOwner();
  const tag = tagFor(owner);
  if (!tag) return { env, stop: async () => undefined };
  const stop = () => stopOwned(owner);
  own(stop);
  return { env: { ...env, DEN_HOST_TAG: tag }, stop };
}

const ENGINE = path.resolve(__dirname, "..");
const LOADER = path.join(ENGINE, "node_modules/tsx/dist/loader.mjs");

export interface TestHost {
  child: ChildProcess;
  /** Stop it now (its group): SIGTERM, then SIGKILL after `graceMs`. */
  stop: (graceMs?: number) => Promise<void>;
}

/**
 * Start `script` (a helper host: `node --import <tsx loader> <script>
 * <stateDir> --tag=<tag>`) in a process group of its own. It is stopped
 * after the test that started it, or after the file when a hook started it,
 * even when the test throws first.
 */
export function startTestHost(
  script: string,
  stateDir: string,
  opts: SpawnOptions = {},
): TestHost {
  const owner = newOwner();
  const tag = tagFor(owner);
  const child = spawn(
    process.execPath,
    [
      "--import",
      `file://${LOADER}`,
      script,
      stateDir,
      ...(tag ? [`--tag=${tag}`] : []),
    ],
    { stdio: "ignore", ...opts, detached: true },
  );
  const host: TestHost = {
    child,
    stop: async (graceMs = 5_000) => {
      if (tag) await stopOwned(owner, graceMs);
      // And its group, in case it never got as far as its command line.
      if (child.pid && child.exitCode === null && child.signalCode === null)
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          /* gone */
        }
    },
  };
  own(() => host.stop());
  return host;
}
