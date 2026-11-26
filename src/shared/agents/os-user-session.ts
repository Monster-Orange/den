import { spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { OWN_FOLDER, readAgentLaunch } from "./os-user-launch-files.js";
import type { SandboxWrap } from "./sandbox.js";
import { readTokenLine } from "./session-token.js";

const CMD = "`agents session`";

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const NONCE_RE = /^[0-9a-f]{32}$/;
export const LOGIN_TMP_BASE = "t";

export const EXIT_USAGE = 64;
export const EXIT_REFUSED = 65;
export const EXIT_FAILED = 70;

export interface AgentSessionDeps {
  home: string;
  personUid: number;
  ownUid: number;
  readToken: (nonce: string) => Promise<string>;
  makeTmp: () => string | undefined;
  removeTmp: (dir: string) => void;
  wrap: (argv: string[], o: { tmp?: string; ownDir: string }) => SandboxWrap;
  run: (
    argv: string[],
    o: { cwd: string; env: Record<string, string> },
  ) => Promise<number>;
  err: (m: string) => void;
}

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
  if (d.personUid === 0 || d.personUid === d.ownUid) {
    d.err(
      `${CMD}: the launch files' owner (uid ${d.personUid}) is this login or root: they must be the person's`,
    );
    return EXIT_REFUSED;
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

function makeLoginTmp(home: string): string {
  const base = path.join(home, LOGIN_TMP_BASE);
  fs.mkdirSync(base, { recursive: true, mode: 0o700 });
  return fs.mkdtempSync(path.join(base, "den-"));
}

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
    return;
  }
}

export function defaultAgentSessionDeps(
  env: NodeJS.ProcessEnv = process.env,
): AgentSessionDeps {
  const home = env.HOME ?? "";
  const agentsDir = path.join(path.dirname(home), "agents");
  let personUid = -1;
  try {
    personUid = fs.statSync(agentsDir).uid;
  } catch {
    personUid = -1;
  }
  return {
    home,
    personUid,
    ownUid: typeof process.getuid === "function" ? process.getuid() : -1,
    readToken: (nonce) =>
      readTokenLine(process.stdin, (t) => process.stdout.write(t), { nonce }),
    makeTmp: () => makeLoginTmp(home),
    removeTmp: (dir) => removeLoginTmp(home, dir),
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
