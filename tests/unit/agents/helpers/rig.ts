/**
 * An in-process session host on a temp state dir with a scripted PTY (no
 * native module, nothing really runs), and the deps `<cli> agents` needs:
 * two workspaces with checkout dirs of their own, a `claude` PATH shim that
 * only records a run, and the agents config a test sets.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { connectHost } from "../../../../src/shared/sessions/client.js";
import { SessionHost } from "../../../../src/shared/sessions/host.js";
import { sessionPaths } from "../../../../src/shared/sessions/paths.js";
import type { PtyLoad } from "../../../../src/shared/sessions/pty.js";
import type { ResolvedAgentsConfig } from "../../../../src/shared/den-config.js";
import type { AgentsDeps } from "../../../../src/ui/cli/agents-command.js";
import {
  scriptedFactory,
  type ScriptedPty,
} from "../../sessions/helpers/fake-pty.js";

export interface Rig {
  dir: string;
  stateDir: string;
  deps: AgentsDeps;
  made: ScriptedPty[];
  out: string[];
  err: string[];
  /** The `claude` shim's record of any run (must never exist). */
  ran: string;
  claude: string;
  wsDir: (ws: string) => string;
  config: ResolvedAgentsConfig;
}

const tmps: string[] = [];
const hosts: SessionHost[] = [];

/** Close every host and remove every temp dir the rigs made. */
export async function cleanupRigs(): Promise<void> {
  for (const h of hosts.splice(0)) await h.close();
  for (const d of tmps.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
}

export async function rig(over: Partial<AgentsDeps> = {}): Promise<Rig> {
  // realpath: macOS's tmpdir is a symlink, and cwd comparisons need one form.
  const dir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "den-agents-")),
  );
  tmps.push(dir);
  const stateDir = path.join(dir, "state");
  fs.mkdirSync(stateDir);
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  const ran = path.join(dir, "claude-ran");
  const claude = path.join(bin, "claude");
  fs.writeFileSync(claude, `#!/bin/sh\necho "$@" >> "${ran}"\nexit 1\n`, {
    mode: 0o755,
  });
  const wsDir = (ws: string) => path.join(dir, "workspaces", ws);
  for (const ws of ["north", "south"])
    fs.mkdirSync(wsDir(ws), { recursive: true });

  const { factory, made } = scriptedFactory();
  const load: PtyLoad = { available: true, factory };
  const h = new SessionHost({
    stateDir,
    pty: () => load,
    flushMs: 0,
    log: () => undefined,
  });
  hosts.push(h);
  await h.listen();

  const r: Rig = {
    dir,
    stateDir,
    made,
    out: [],
    err: [],
    ran,
    claude,
    wsDir,
    config: { maxConcurrent: 4, personaPacks: [], agents: {} },
    deps: {},
  };
  r.deps = {
    dist: "acme",
    cli: "acme",
    connect: () => connectHost(sessionPaths(stateDir).socket),
    pty: () => load,
    workspaceExists: (ws) => ["north", "south"].includes(ws),
    maxConcurrent: () => r.config.maxConcurrent,
    agentsConfig: () => r.config,
    distRoot: () => dir,
    stateDir: () => stateDir,
    workspaceDir: wsDir,
    mcpServer: () => ({
      command: "/dist/bin/acme",
      env: { PATH: "/usr/bin:/bin" },
    }),
    invokeCwd: () => dir,
    // No early-exit watch unless a test asks for one (it waits up to 3 s).
    exitWatchMs: 0,
    env: {
      PATH: `${bin}:/usr/bin:/bin`,
      HOME: "/home/someone",
      SOME_TOKEN: "secret-value-123",
    },
    out: (l) => r.out.push(l),
    err: (l) => r.err.push(l),
    ...over,
  };
  return r;
}

/** Let the host's exit and kill events land. */
export const settle = (ms = 100) =>
  new Promise<void>((res) => setTimeout(res, ms));
