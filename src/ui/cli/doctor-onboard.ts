/**
 * `doctor --json`'s onboarding checks (ON-2): what an agent setting Den up
 * needs to know, each `ok`, `warn` or `fail`, with a command the agent can
 * run (`fix`) or a question for the person (`ask`).
 *
 * - node: Node 22.13 or later.
 * - git: on PATH.
 * - docker: only when a registered repo needs it (a compose file or block,
 *   or a docker command), then installed and its daemon answering.
 * - web: the web server answers at its URL (and is this distribution's).
 * - mcp: Den's MCP one-shot (`<cli> mcp --call workspaces`) gets an answer
 *   from that web server: the path every agent's tools take.
 *
 * Every probe is injected (OnboardDeps), so tests never depend on this
 * machine's Docker, Node or web server. defaultOnboardDeps() wires the real
 * ones; only the docker and mcp probes spawn, each bounded by a timeout.
 */
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { product } from "../../shared/product.js";
import { getDistRoot } from "../../shared/paths.js";
import { readManifest } from "../../shared/manifest/read-manifest.js";
import {
  DEN_SERVICES_DIR,
  readWorkspacesFile,
} from "../../shared/environment-manager/workspaces.js";
import { readWebPort } from "../../shared/edge/config.js";
import { DEFAULT_PORT } from "../../shared/constants.js";
import { needsDocker } from "./repo-detect.js";
import { readMcpConfig } from "../../shared/den-config.js";
import { approvalsState } from "../mcp/tools.js";
import type { WebProbe } from "./mcp-connect.js";

export type CheckStatus = "ok" | "warn" | "fail";

export interface OnboardCheck {
  id: string;
  status: CheckStatus;
  detail: string;
  /** A command the agent can run to fix it. */
  fix?: string;
  /** A question for the person, when only they can fix it. */
  ask?: string;
  /** The web server's URL and port (the web check). */
  url?: string;
  port?: number;
}

export interface OnboardDeps {
  /** process.versions.node */
  nodeVersion: string;
  platform: NodeJS.Platform;
  /** Whether an executable is on PATH. */
  which: (bin: string) => boolean;
  /** The registered repos that need Docker. */
  dockerRepos: () => string[];
  /** Whether the Docker daemon answers (`docker info`). */
  dockerUp: () => boolean;
  webUrl: string;
  probeWeb: (url: string) => Promise<WebProbe>;
  /** The MCP one-shot against the web server: exit 0, or why not. */
  mcpCall: () => { ok: boolean; detail?: string };
  /** `mcp.approvals` (throws on a bad value): whether the held writes are on. */
  approvals: () => boolean;
  /** The command an agent runs, e.g. `./bin/acme`. */
  bin: string;
}

export const MIN_NODE = [22, 13] as const;

/** Whether `version` ("22.13.0", "v24.1.0") is at least 22.13. */
export function nodeOk(version: string): boolean {
  const [maj, min] = version.replace(/^v/, "").split(".").map(Number);
  if (!Number.isFinite(maj)) return false;
  return (
    maj > MIN_NODE[0] || (maj === MIN_NODE[0] && (min ?? 0) >= MIN_NODE[1])
  );
}

export async function onboardingChecks(
  d: OnboardDeps,
): Promise<OnboardCheck[]> {
  const out: OnboardCheck[] = [];
  const mac = d.platform === "darwin";

  out.push(
    nodeOk(d.nodeVersion)
      ? { id: "node", status: "ok", detail: `Node ${d.nodeVersion}` }
      : {
          id: "node",
          status: "fail",
          detail: `Node ${d.nodeVersion} is older than ${MIN_NODE.join(".")}`,
          fix: "nvm install 22 && nvm use 22",
          ask: `Den needs Node ${MIN_NODE.join(".")} or later. May I install it with your usual Node installer (nvm, or brew install node)?`,
        },
  );

  out.push(
    d.which("git")
      ? { id: "git", status: "ok", detail: "git is on PATH" }
      : {
          id: "git",
          status: "fail",
          detail: "git is not on PATH",
          ...(mac ? { fix: "xcode-select --install" } : {}),
          ask: "Den needs git. May I install it (on macOS: xcode-select --install)?",
        },
  );

  const repos = d.dockerRepos();
  if (repos.length === 0)
    out.push({
      id: "docker",
      status: "ok",
      detail: "no registered repo needs Docker",
    });
  else if (!d.which("docker"))
    out.push({
      id: "docker",
      status: "fail",
      detail: `${repos.join(", ")} need${repos.length === 1 ? "s" : ""} Docker, and docker is not on PATH`,
      ask: "These repos run in containers. Can you install Docker Desktop (or another Docker engine)?",
    });
  else if (!d.dockerUp())
    out.push({
      id: "docker",
      status: "fail",
      detail: `${repos.join(", ")} need${repos.length === 1 ? "s" : ""} Docker, and the Docker daemon is not answering`,
      ...(mac ? { fix: "open -a Docker" } : {}),
      ask: "Docker is installed but not running. Can you start it?",
    });
  else
    out.push({
      id: "docker",
      status: "ok",
      detail: `Docker is running (needed by ${repos.join(", ")})`,
    });

  const probe = await d.probeWeb(d.webUrl);
  const webPort = Number(new URL(d.webUrl).port) || 80;
  const webFix = `${d.bin} web up --no-open --json`;
  if (probe.kind === "up")
    out.push({
      id: "web",
      status: "ok",
      detail: `web server up${probe.version ? ` (Den ${probe.version})` : ""}`,
      url: d.webUrl,
      port: webPort,
    });
  else if (probe.kind === "foreign")
    out.push({
      id: "web",
      status: "fail",
      detail: `${probe.who} answers at ${d.webUrl}, not this distribution's web server`,
      url: d.webUrl,
      port: webPort,
      ask: `Another Den distribution already uses ${d.webUrl}. Which port should ${product().title} use instead? (web.port in config/local/user.yml)`,
    });
  else
    out.push({
      id: "web",
      status: "fail",
      detail:
        probe.kind === "timeout"
          ? `web server at ${d.webUrl} is not answering in time`
          : `web server not running at ${d.webUrl}`,
      url: d.webUrl,
      port: webPort,
      fix:
        probe.kind === "timeout"
          ? `${d.bin} web restart --no-open --json`
          : webFix,
    });

  if (probe.kind !== "up")
    out.push({
      id: "mcp",
      status: "fail",
      detail: "Den's MCP reads through the web server, which is not up",
      fix: webFix,
    });
  else {
    const m = d.mcpCall();
    out.push(
      m.ok
        ? {
            id: "mcp",
            status: "ok",
            detail: `${d.bin} mcp --call workspaces answered`,
          }
        : {
            id: "mcp",
            status: "fail",
            detail: `${d.bin} mcp --call workspaces failed${m.detail ? `: ${m.detail}` : ""}`,
            fix: `${d.bin} web restart --no-open --json`,
          },
    );
  }
  out.push(approvalsCheck(d));
  return out;
}

/** `mcp:approvals`: which state the held writes are in. Never needs the server. */
function approvalsCheck(d: OnboardDeps): OnboardCheck {
  let on: boolean;
  try {
    on = d.approvals();
  } catch (err) {
    return {
      id: "mcp:approvals",
      status: "fail",
      detail: (err as Error).message,
      ask: "Set mcp.approvals in the distribution config to true or false.",
    };
  }
  return {
    id: "mcp:approvals",
    status: "ok",
    detail: approvalsState({ approvals: on }),
  };
}

function onPath(bin: string): boolean {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    try {
      fs.accessSync(path.join(dir, bin), fs.constants.X_OK);
      return true;
    } catch {
      /* next */
    }
  }
  return false;
}

/** The repos in every active workspace whose manifest or files need Docker. */
export function registeredDockerRepos(): string[] {
  const out: string[] = [];
  let file;
  try {
    file = readWorkspacesFile();
  } catch {
    return out;
  }
  for (const ws of file.active) {
    for (const [addr, entry] of Object.entries(
      file.workspaces[ws]?.services ?? {},
    )) {
      const repo = addr.split("/")[0];
      if (out.includes(repo)) continue;
      const dir =
        entry.mode === "dev-managed"
          ? entry.path
          : path.join(DEN_SERVICES_DIR, repo, entry.branch ?? "main");
      if (!dir) continue;
      if (needsDocker(readManifest(dir), fs.existsSync(dir) ? dir : undefined))
        out.push(repo);
    }
  }
  return out;
}

/** The command an agent runs from the distribution root. */
export function runnableCli(): string {
  const cli = product().cli;
  return fs.existsSync(path.join(getDistRoot(), "bin", cli))
    ? `./bin/${cli}`
    : cli;
}

export function defaultOnboardDeps(
  probeWeb: (url: string) => Promise<WebProbe>,
): OnboardDeps {
  let port: number;
  try {
    port = readWebPort();
  } catch {
    port = DEFAULT_PORT;
  }
  const cli = product().cli;
  const shim = path.join(getDistRoot(), "bin", cli);
  return {
    nodeVersion: process.versions.node,
    platform: process.platform,
    which: onPath,
    dockerRepos: registeredDockerRepos,
    dockerUp: () =>
      spawnSync("docker", ["info", "--format", "{{.ServerVersion}}"], {
        stdio: "ignore",
        timeout: 10_000,
      }).status === 0,
    webUrl: `http://localhost:${port}`,
    probeWeb,
    mcpCall: () => {
      // The shim when there is one (a distribution), else this Den's bin.
      const cmd = fs.existsSync(shim)
        ? shim
        : path.join(getDistRoot(), "bin", "den");
      const r = spawnSync(cmd, ["mcp", "--call", "workspaces"], {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 30_000,
      });
      return r.status === 0
        ? { ok: true }
        : {
            ok: false,
            detail:
              (r.stderr ?? "").trim().split("\n").pop()?.slice(0, 200) ||
              `exit ${r.status ?? "timeout"}`,
          };
    },
    approvals: () => readMcpConfig().approvals,
    bin: runnableCli(),
  };
}
