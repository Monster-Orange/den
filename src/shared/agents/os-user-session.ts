/**
 * Issue 988, slice 2: `agents session <id> <nonce>`, what the launcher
 * (os-user.ts launcherScript) runs as the agents' own login.
 *
 * In this order, so a bad launch file never gets a token:
 *   1. the agent's launch files, only if they pass doctor's check
 *      (os-user-launch-files.ts readAgentLaunch);
 *   2. the sign-in token, on the terminal after Den's nonce marker
 *      (session-token.ts readTokenLine);
 *   3. its own temp folder (issue 1325), in the login's home;
 *   4. the runtime, in the agent sandbox, with the token in its env only.
 * A sandbox that can't start ends the launch: never an unsandboxed agent.
 * The temp folder goes when the runtime ends, however it ends.
 */
import { spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { OWN_FOLDER, readAgentLaunch } from "./os-user-launch-files.js";
import type { SandboxWrap } from "./sandbox.js";
import { readTokenLine } from "./session-token.js";

/** The command these messages come from. */
const CMD = "`agents session`";

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const NONCE_RE = /^[0-9a-f]{32}$/;
/** The temp folders' base, in the login's home (short: socket paths). */
export const LOGIN_TMP_BASE = "t";

export const EXIT_USAGE = 64;
export const EXIT_REFUSED = 65;
export const EXIT_FAILED = 70;

export interface AgentSessionDeps {
  /** The login's home (the launcher sets HOME): /opt/den/<person>/home. */
  home: string;
  /** The person's uid: the launch files must be theirs. */
  personUid: number;
  readToken: (nonce: string) => Promise<string>;
  /** Makes the session's temp folder; undefined when none was made. */
  makeTmp: () => string | undefined;
  removeTmp: (dir: string) => void;
  /** The runtime's argv in the agent sandbox, or why it can't be. */
  wrap: (argv: string[], o: { tmp?: string; ownDir: string }) => SandboxWrap;
  /** Runs it on this terminal; resolves its exit code. */
  run: (
    argv: string[],
    o: { cwd: string; env: Record<string, string> },
  ) => Promise<number>;
  err: (m: string) => void;
}

/** `agents session <id> <nonce>`; returns the exit code. */
export async function runAgentSession(
  args: string[],
  d: AgentSessionDeps,
): Promise<number> {
  const [id, nonce] = args;
  if (
    args.length !== 2 ||
    !id ||
    !ID_RE.test(id) ||
    !nonce ||
    !NONCE_RE.test(nonce)
  ) {
    d.err(`${CMD}: give one agent id and Den's launch nonce`);
    return EXIT_USAGE;
  }
  const agentsDir = path.join(path.dirname(d.home), "agents");
  let spec;
  try {
    spec = readAgentLaunch(agentsDir, id, d.personUid);
  } catch (e) {
    d.err(String((e as Error).message));
    return EXIT_REFUSED;
  }
  let token: string;
  try {
    token = await d.readToken(nonce);
  } catch (e) {
    d.err(String((e as Error).message));
    return EXIT_REFUSED;
  }
  const tmp = d.makeTmp();
  try {
    const w = d.wrap(spec.argv, {
      tmp,
      ownDir: path.join(agentsDir, id, OWN_FOLDER),
    });
    if (!w.applied) {
      d.err(
        `${CMD}: the agent sandbox can't start (${w.reason ?? "no reason given"}), so the agent doesn't`,
      );
      return EXIT_REFUSED;
    }
    const env: Record<string, string> = {
      ...spec.env,
      ...w.env,
      ...(tmp ? { TMPDIR: tmp } : {}),
      ...(spec.tokenEnv ? { [spec.tokenEnv]: token } : {}),
    };
    try {
      return await d.run(w.argv, { cwd: spec.cwd, env });
    } catch (e) {
      d.err(`${CMD}: the runtime didn't start: ${(e as Error).message}`);
      return EXIT_FAILED;
    }
  } finally {
    if (tmp) d.removeTmp(tmp);
  }
}

/** Makes <home>/t/den-XXXXXX, the login's, 0700. */
function makeLoginTmp(home: string): string {
  const base = path.join(home, LOGIN_TMP_BASE);
  fs.mkdirSync(base, { recursive: true, mode: 0o700 });
  return fs.mkdtempSync(path.join(base, "den-"));
}

/** Removes a temp folder only if it sits right inside the base. */
function removeLoginTmp(home: string, dir: string): void {
  const base = path.join(home, LOGIN_TMP_BASE);
  if (
    path.dirname(dir) !== base ||
    !/^den-[A-Za-z0-9]{6}$/.test(path.basename(dir))
  )
    return;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort: doctor lists what is left */
  }
}

/** The real terminal, the real login. */
export function defaultAgentSessionDeps(
  env: NodeJS.ProcessEnv = process.env,
): AgentSessionDeps {
  const home = env.HOME ?? "";
  const agentsDir = path.join(path.dirname(home), "agents");
  let personUid = -1;
  try {
    // Setup made agents/ the person's; the login can't change its owner.
    personUid = fs.statSync(agentsDir).uid;
  } catch {
    /* readAgentLaunch then says the files are missing */
  }
  return {
    home,
    personUid,
    readToken: (nonce) =>
      readTokenLine(process.stdin, (t) => process.stdout.write(t), { nonce }),
    makeTmp: () => makeLoginTmp(home),
    removeTmp: (dir) => removeLoginTmp(home, dir),
    // The login's own sandbox policy is the next step of slice 2. Until
    // it is in, nothing starts: never an unsandboxed agent.
    wrap: (argv) => ({
      applied: false,
      argv,
      env: {},
      reason: "the agents' login has no sandbox policy yet",
    }),
    run: (argv, o) =>
      new Promise((resolve, reject) => {
        const c = spawn(argv[0]!, argv.slice(1), {
          cwd: o.cwd,
          env: o.env,
          stdio: "inherit",
        });
        c.on("error", reject);
        c.on("exit", (code, sig) =>
          resolve(code ?? (sig ? 128 + (os.constants.signals[sig] ?? 1) : 1)),
        );
      }),
    err: (m) => process.stderr.write(`✗ ${m}\n`),
  };
}
