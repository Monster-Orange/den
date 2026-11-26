/**
 * Issue 988, slice 2: an agent's launch files under the agents' own login.
 *
 * Den's server runs as the person and owns /opt/den/<person>/agents (made
 * at setup, person:den-<person>, 3770). For each agent it writes:
 *
 *   agents/<id>/              person:den-<person>, 2750
 *   agents/<id>/launch.json   person, 0640: what `agents session` starts
 *   agents/<id>/own/          person:den-<person>, 2770: the agent's own
 *                             writable files (handoff.md, notes, counts)
 *
 * So the agents' login reads its launch file and can't change, rename or
 * add one (Reviewer D's pin 3). No sudo after setup: the person owns the
 * folders. launch.json never holds a secret: the sign-in token comes on
 * the session's terminal (session-token.ts), and an env name like a
 * secret's is refused before anything is written.
 *
 * Both sides check them: doctor (launchFileProblems) and `agents session`
 * (readAgentLaunch), which refuses to start from files that fail.
 */
import * as fs from "fs";
import * as path from "path";
import { writeFileAtomic } from "../atomic-write.js";

/** The command these messages come from. */
const CMD = "`agents session`";

export const LAUNCH_FILE = "launch.json";
export const OWN_FOLDER = "own";
const DIR_MODE = 0o2750;
const FILE_MODE = 0o640;
const OWN_MODE = 0o2770;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Names that hold a secret: never written to a launch file. */
const SECRETISH =
  /TOKEN|SECRET|PASSW|API_?KEY|PRIVATE|CREDENTIAL|COOKIE|SESSION_?KEY/i;

export interface AgentLaunchSpec {
  agentId: string;
  /** The runtime's argv, as Den builds it (no secret in it). */
  argv: string[];
  /** The agent's working folder. */
  cwd: string;
  /** The session's env beyond the launcher's: never a secret. */
  env: Record<string, string>;
  /**
   * The env name the runtime reads its sign-in token from (the catalog's:
   * CLAUDE_CODE_OAUTH_TOKEN for Claude Code). A name only: the token itself
   * comes on the terminal.
   */
  tokenEnv?: string;
}

function checkSpec(s: AgentLaunchSpec): void {
  if (!ID_RE.test(s.agentId) || s.agentId === "." || s.agentId === "..")
    throw new Error(`launch files: "${s.agentId}" is not an agent id`);
  if (
    !Array.isArray(s.argv) ||
    s.argv.length === 0 ||
    !s.argv.every((a) => typeof a === "string")
  )
    throw new Error("launch files: the runtime's argv is empty or not strings");
  if (typeof s.cwd !== "string" || !path.isAbsolute(s.cwd))
    throw new Error(
      `launch files: the working folder must be absolute (got ${JSON.stringify(s.cwd)})`,
    );
  if (s.tokenEnv !== undefined && !ENV_NAME_RE.test(s.tokenEnv))
    throw new Error(
      `launch files: the token's env name "${s.tokenEnv}" is not an env name`,
    );
  for (const [k, v] of Object.entries(s.env)) {
    if (!ENV_NAME_RE.test(k) || typeof v !== "string")
      throw new Error(
        `launch files: "${k}" is not an env name with a text value`,
      );
    if (SECRETISH.test(k))
      throw new Error(
        `launch files: ${k} looks like a secret, and launch files never hold one (the token comes on the terminal)`,
      );
  }
}

/** Makes `dir` with `mode` if absent; refuses a link or a non-folder there. */
function ensureDir(dir: string, mode: number): void {
  const st = fs.lstatSync(dir, { throwIfNoEntry: false });
  if (st?.isSymbolicLink())
    throw new Error(
      `launch files: ${dir} is a link; Den writes nothing through it`,
    );
  if (st && !st.isDirectory())
    throw new Error(`launch files: ${dir} is not a folder`);
  if (!st) fs.mkdirSync(dir, { mode });
  // The umask and the parent's setgid can change what mkdir made.
  fs.chmodSync(dir, mode);
}

/** Den's server: writes (or replaces) an agent's launch files. */
export function writeAgentLaunch(agentsDir: string, s: AgentLaunchSpec): void {
  checkSpec(s);
  const dir = path.join(agentsDir, s.agentId);
  ensureDir(dir, DIR_MODE);
  ensureDir(path.join(dir, OWN_FOLDER), OWN_MODE);
  const file = path.join(dir, LAUNCH_FILE);
  if (fs.lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink())
    throw new Error(
      `launch files: ${file} is a link; Den writes nothing through it`,
    );
  // 2750: the person (its owner) writes; the login only reads.
  writeFileAtomic(
    file,
    `${JSON.stringify({ agentId: s.agentId, argv: s.argv, cwd: s.cwd, env: s.env, ...(s.tokenEnv ? { tokenEnv: s.tokenEnv } : {}) }, null, 2)}\n`,
    { mode: FILE_MODE },
  );
}

const oct = (m: number) => `0${(m & 0o7777).toString(8)}`;

/**
 * What is wrong with an agent's launch files, for doctor and for `agents
 * session` (none: they are safe to start from). `personUid` owns them.
 */
export function launchFileProblems(
  agentsDir: string,
  agentId: string,
  personUid: number,
): string[] {
  const dir = path.join(agentsDir, agentId);
  const d = fs.lstatSync(dir, { throwIfNoEntry: false });
  if (!d)
    return [
      `${agentId}: no launch files (Den writes them when it starts the agent)`,
    ];
  const out: string[] = [];
  const check = (
    p: string,
    st: fs.Stats,
    want: number,
    kind: "dir" | "file",
  ) => {
    const name = path.relative(agentsDir, p);
    if (st.isSymbolicLink()) return out.push(`${name} is a link`);
    if (kind === "dir" ? !st.isDirectory() : !st.isFile())
      return out.push(`${name} is not a ${kind === "dir" ? "folder" : "file"}`);
    if (st.uid !== personUid)
      out.push(`${name} is not the person's (owner uid ${st.uid})`);
    // The permission bits decide who writes; setgid only passes the group
    // down (macOS does that anyway), and a sandboxed caller can't set it.
    if ((st.mode & 0o777) !== (want & 0o777))
      out.push(
        `${name} is ${oct(st.mode & 0o777)}; it must be ${oct(want & 0o777)}`,
      );
  };
  check(dir, d, DIR_MODE, "dir");
  if (!d.isDirectory() || d.isSymbolicLink()) return out;
  for (const n of fs.readdirSync(dir))
    if (n !== LAUNCH_FILE && n !== OWN_FOLDER)
      out.push(
        `${path.join(agentId, n)} is not Den's: only ${LAUNCH_FILE} and ${OWN_FOLDER}/ belong there`,
      );
  const f = path.join(dir, LAUNCH_FILE);
  const fst = fs.lstatSync(f, { throwIfNoEntry: false });
  if (!fst) out.push(`${path.join(agentId, LAUNCH_FILE)} is missing`);
  else check(f, fst, FILE_MODE, "file");
  const o = path.join(dir, OWN_FOLDER);
  const ost = fs.lstatSync(o, { throwIfNoEntry: false });
  if (!ost) out.push(`${path.join(agentId, OWN_FOLDER)}/ is missing`);
  else check(o, ost, OWN_MODE, "dir");
  return out;
}

/** `agents session`: the launch spec, only from files that pass every check. */
export function readAgentLaunch(
  agentsDir: string,
  agentId: string,
  personUid: number,
): AgentLaunchSpec {
  const bad = launchFileProblems(agentsDir, agentId, personUid);
  if (bad.length)
    throw new Error(
      `${CMD}: the launch files can't be trusted: ${bad.join("; ")}`,
    );
  const raw = JSON.parse(
    fs.readFileSync(path.join(agentsDir, agentId, LAUNCH_FILE), "utf8"),
  ) as AgentLaunchSpec;
  const s: AgentLaunchSpec = {
    agentId: raw.agentId,
    argv: raw.argv,
    cwd: raw.cwd,
    env: raw.env ?? {},
    ...(raw.tokenEnv !== undefined ? { tokenEnv: raw.tokenEnv } : {}),
  };
  checkSpec(s);
  if (s.agentId !== agentId)
    throw new Error(
      `${CMD}: the launch file is for ${s.agentId}, not ${agentId}`,
    );
  return s;
}
