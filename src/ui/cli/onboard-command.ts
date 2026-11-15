/**
 * `<cli> onboard status [--json]` (ON-3): what's set up and the one next
 * step, the CLI twin of the MCP tool `onboard_status` and of
 * GET /api/onboard/status. `doctor --json` has the machine checks (Node,
 * git, Docker, the web server, Den's MCP); this adds what onboarding needs
 * on top (a distribution, workspaces, repos, a running service) and picks
 * the next step. Reads only. It never runs an agent's CLI: Den's MCP is
 * checked in the agents' config files (onboard-reads.ts mcpRegistration).
 * Exit 0 whenever it answers, whatever is left to do.
 */
import { execFile } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { product } from "../../shared/product.js";
import { getDistRoot } from "../../shared/paths.js";
import {
  DEN_SERVICES_DIR,
  readWorkspacesFile,
} from "../../shared/environment-manager/workspaces.js";
import { listDaemons } from "../../shared/environment-manager/service-runner.js";
import { defaultOnboardDeps, runnableCli } from "./doctor-onboard.js";
import type { WebProbe } from "./mcp-connect.js";
import {
  mcpRegistration,
  onboardStatus,
  type OnboardStatus,
  type OnboardStatusDeps,
  type RegisteredRepo,
} from "./onboard-reads.js";
import { printJson } from "./json-out.js";
import {
  readDenConfig,
  readWebServiceConfig,
} from "../../shared/den-config.js";
import { getStateDir } from "../../shared/paths.js";
import { serviceJobState, webOnlyHostDetail } from "./doctor-where.js";
import { askLiveHost, hostLabel } from "./service-command.js";

/** Every repo in a workspace, at the folder Den runs it from. */
export function registeredRepos(): RegisteredRepo[] {
  let file;
  try {
    file = readWorkspacesFile();
  } catch {
    return [];
  }
  const out: RegisteredRepo[] = [];
  for (const [workspace, ws] of Object.entries(file.workspaces))
    for (const [addr, entry] of Object.entries(ws?.services ?? {})) {
      const repo = addr.split("/")[0];
      const dir =
        entry.mode === "dev-managed"
          ? entry.path
          : path.join(DEN_SERVICES_DIR, repo, entry.branch ?? "main");
      if (dir) out.push({ path: dir, workspace, repo });
    }
  return out;
}

function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf-8");
  } catch {
    return null;
  }
}

/** Whether the Docker daemon answers, without blocking the event loop. */
function dockerUpAsync(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(
      "docker",
      ["info", "--format", "{{.ServerVersion}}"],
      { timeout: 10_000 },
      (err) => resolve(!err),
    );
  });
}

/** This machine's deps for onboardStatus. */
export async function defaultStatusDeps(o: {
  probeWeb: (url: string) => Promise<WebProbe>;
  webUrl?: string;
  viaMcp?: boolean;
}): Promise<OnboardStatusDeps> {
  const doctor = defaultOnboardDeps(o.probeWeb);
  if (o.webUrl) doctor.webUrl = o.webUrl;
  // Docker is asked only when a registered repo needs it, and asynchronously:
  // the web server answers this route too.
  const dockerRepos = doctor.dockerRepos();
  const dockerUp =
    dockerRepos.length && doctor.which("docker")
      ? await dockerUpAsync()
      : false;
  const bin = runnableCli();
  return {
    bin,
    // Drill (a): the server agent reads this (onboard_status), as doctor.
    hostOwner: async () => {
      if (process.platform !== "darwin") return null;
      const home = os.homedir();
      const uid = process.getuid?.() ?? 0;
      const { label } = readWebServiceConfig(
        readDenConfig(),
        getDistRoot(),
        home,
      );
      const svc = serviceJobState(label, home, uid);
      if (!svc || svc.state === "not-loaded") return null;
      const hostJob = serviceJobState(hostLabel(label), home, uid);
      if (hostJob && hostJob.state !== "not-loaded") return null;
      const live = await askLiveHost(getStateDir());
      if (!live) return null;
      return {
        id: "host",
        status: "warn",
        detail: webOnlyHostDetail(live.pid, bin),
        fix: `${bin} service install`,
      };
    },
    distribution: fs.existsSync(path.join(getDistRoot(), "bin", product().cli)),
    doctor: {
      ...doctor,
      dockerRepos: () => dockerRepos,
      dockerUp: () => dockerUp,
    },
    workspaces: () => {
      let file;
      try {
        file = readWorkspacesFile();
      } catch {
        return { names: [], active: [], repos: [] };
      }
      const repos = new Set<string>();
      for (const ws of Object.values(file.workspaces))
        for (const addr of Object.keys(ws?.services ?? {}))
          repos.add(addr.split("/")[0]);
      return {
        names: Object.keys(file.workspaces),
        active: file.active.filter((n) => n in file.workspaces),
        repos: [...repos],
      };
    },
    running: () => {
      try {
        return listDaemons().map((d) => d.address);
      } catch {
        return [];
      }
    },
    mcp: () =>
      mcpRegistration({
        cli: bin,
        home: os.homedir(),
        platform: process.platform,
        appData: process.env.APPDATA,
        projectDir: getDistRoot(),
        which: doctor.which,
        read: readText,
        viaMcp: o.viaMcp,
      }),
  };
}

const MARK: Record<string, string> = { ok: "✓", warn: "!", todo: "·" };

function printHuman(r: OnboardStatus): void {
  for (const c of r.checks)
    console.log(`  ${MARK[c.status] ?? " "} ${c.id.padEnd(12)} ${c.detail}`);
  console.log(`\n  Next: ${r.next.step}`);
  if (r.next.command) console.log(`  Run:  ${r.next.command}`);
}

export const ONBOARD_USAGE = () => `${product().cli} onboard status [--json]`;

/** `onboard <sub> …`; returns the exit code. */
export async function cmdOnboard(
  argv: string[],
  probeWeb: (url: string) => Promise<WebProbe>,
): Promise<number> {
  const [sub, ...rest] = argv;
  const json = rest.includes("--json");
  const unknown = rest.filter((a) => a !== "--json");
  if (sub !== "status" || unknown.length) {
    const error =
      sub === undefined || sub === "--help" || sub === "-h"
        ? null
        : sub !== "status"
          ? `unknown onboard subcommand "${sub}"`
          : `unknown flag ${unknown[0]}`;
    if (json && error)
      printJson({
        ok: false,
        error,
        fix: `${runnableCli()} onboard status --json`,
      });
    else {
      if (error) console.error(`✗ ${error}`);
      console.log(
        `\n  ${ONBOARD_USAGE()}\n\n  What's set up (a distribution, the web server, projects, repos,\n  a running service, Den's MCP) and the one next step, with its command.\n`,
      );
    }
    return error ? 2 : sub === undefined ? 1 : 0;
  }
  const r = await onboardStatus(await defaultStatusDeps({ probeWeb }));
  if (json) printJson(r);
  else printHuman(r);
  return 0;
}
