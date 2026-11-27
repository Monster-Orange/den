import * as fs from "fs";
import * as path from "path";
import { writeFileAtomic } from "../atomic-write.js";

const CMD = "`agents session`";

export const LAUNCH_FILE = "launch.json";
export const OWN_FOLDER = "own";
const DIR_MODE = 0o2750;
const FILE_MODE = 0o640;
const OWN_MODE = 0o2770;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SECRETISH =
  /TOKEN|SECRET|PASSW|API_?KEY|PRIVATE|CREDENTIAL|COOKIE|SESSION_?KEY/i;

export interface AgentLaunchSpec {
  agentId: string;
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  tokenFdEnv?: string;
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
  if ((s as { tokenEnv?: unknown }).tokenEnv !== undefined)
    throw new Error(
      "launch files: a token never goes in the environment; tokenFdEnv names the variable that gives its file descriptor",
    );
  if (
    s.tokenFdEnv !== undefined &&
    !(
      ENV_NAME_RE.test(s.tokenFdEnv) &&
      s.tokenFdEnv.endsWith("_FILE_DESCRIPTOR")
    )
  )
    throw new Error(
      `launch files: "${s.tokenFdEnv}" is not an env name ending in _FILE_DESCRIPTOR`,
    );
  for (const [k, v] of Object.entries(s.env)) {
    if (!ENV_NAME_RE.test(k) || typeof v !== "string")
      throw new Error(
        `launch files: "${k}" is not an env name with a text value`,
      );
    if (/^(LD_|DYLD_)|^NODE_OPTIONS$/.test(k))
      throw new Error(
        `launch files: "${k}" changes what the runtime loads, so it is never set here`,
      );
    if (SECRETISH.test(k))
      throw new Error(
        `launch files: ${k} looks like a secret, and launch files never hold one (the token comes on the terminal)`,
      );
  }
}

function ensureDir(dir: string, mode: number): void {
  const st = fs.lstatSync(dir, { throwIfNoEntry: false });
  if (st?.isSymbolicLink())
    throw new Error(
      `launch files: ${dir} is a link; Den writes nothing through it`,
    );
  if (st && !st.isDirectory())
    throw new Error(`launch files: ${dir} is not a folder`);
  if (!st) fs.mkdirSync(dir, { mode });
  fs.chmodSync(dir, mode);
}

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
  writeFileAtomic(
    file,
    `${JSON.stringify({ agentId: s.agentId, argv: s.argv, cwd: s.cwd, env: s.env, ...(s.tokenFdEnv ? { tokenFdEnv: s.tokenFdEnv } : {}) }, null, 2)}\n`,
    { mode: FILE_MODE },
  );
}

const oct = (m: number) => `0${(m & 0o7777).toString(8)}`;

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
  ): void => {
    const name = path.relative(agentsDir, p);
    if (st.isSymbolicLink()) {
      out.push(`${name} is a link`);
      return;
    }
    if (kind === "dir" ? !st.isDirectory() : !st.isFile()) {
      out.push(`${name} is not a ${kind === "dir" ? "folder" : "file"}`);
      return;
    }
    if (st.uid !== personUid)
      out.push(`${name} is not the person's (owner uid ${st.uid})`);
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
  ) as AgentLaunchSpec & { tokenEnv?: unknown };
  const s: AgentLaunchSpec & { tokenEnv?: unknown } = {
    agentId: raw.agentId,
    argv: raw.argv,
    cwd: raw.cwd,
    env: raw.env ?? {},
    ...(raw.tokenFdEnv !== undefined ? { tokenFdEnv: raw.tokenFdEnv } : {}),
    ...(raw.tokenEnv !== undefined ? { tokenEnv: raw.tokenEnv } : {}),
  };
  checkSpec(s);
  if (s.agentId !== agentId)
    throw new Error(
      `${CMD}: the launch file is for ${s.agentId}, not ${agentId}`,
    );
  return s;
}
