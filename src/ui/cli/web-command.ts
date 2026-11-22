import { browserOpenRefusal } from "../../shared/browser-open.js";
import {
  ownerGithubLine,
  recordOwnerGithub,
} from "../../shared/owner-github.js";
import { launchdSession, webUpWarning } from "../../shared/launchd-session.js";
import chalk from "chalk";
import { execFileSync, spawn, spawnSync } from "child_process";
import * as fs from "fs";
import * as http from "http";
import { denWebBase, webProbeTarget } from "../../shared/web-dial.js";
import * as path from "path";
import { pathToFileURL } from "url";
import { CLI_SPAWN_TIMEOUT_MS, DEFAULT_PORT } from "../../shared/constants.js";
import { LookupTimeoutError, lookup } from "./proc-lookup.js";
import {
  readSecretsConfig,
  secretsProcessEnv,
  type SecretsConfig,
} from "../../shared/secrets/index.js";
import {
  getDistRoot,
  getEngineRoot,
  getProfile,
  getStateDir,
} from "../../shared/paths.js";
import { envName } from "../../shared/profile.js";
import { hasDenUiMarker } from "../../shared/ui-marker.js";
import {
  cliAuthHeaders,
  ensureWebSecret,
  osUser,
  personToken,
  readWebSecret,
  rotateWebSecret,
} from "../../shared/web-secret.js";
import { newConfirmCode } from "../../shared/confirm-code.js";
import {
  checkLoginCode,
  ignoredConfigWarning,
  localhostOrigin,
  loginLink,
  LOGIN_CODE_TTL_MS,
  mintLoginCode,
  parseOrigin,
  readWebAuthConfig,
  SESSION_TOUCH_MS,
  sessionIdPrefix,
  WebSessionStore,
} from "../../shared/web-session.js";
import { revokeAllActorTokens } from "../../shared/actor-token.js";
import { engineBin, engineModuleFile } from "../../shared/engine.js";
import { readEdgeConfig, readWebPort } from "../../shared/edge/config.js";
import {
  edgeDomains,
  edgeNames,
  webRouteHosts,
} from "../../shared/edge/render.js";
import { containerState } from "../../shared/edge/runtime.js";
import {
  expiringTokenWarning,
  GITHUB_DEVICE_PAGE,
  githubClientId,
  githubEndpoints,
  noClientIdMessage,
} from "../../shared/github-app.js";
import {
  githubDeviceClient,
  githubPrincipal,
  runDeviceFlow,
  type GithubDeviceClient,
} from "../../shared/github-device.js";
import {
  clearWebOwner,
  readWebOwner,
  writeWebOwner,
} from "../../shared/web-owner.js";
import {
  ownServer,
  processCwd,
  refuseForeignServer,
  webReadyWaits,
  samePath,
} from "./server-identity.js";

import { product } from "../../shared/product.js";
import { cmdWebUrl } from "./web-url-command.js";
import {
  notSetLine,
  readWebUrl,
  requireWebUrl,
  type WebUrl,
} from "../../shared/web-url.js";
import { webServiceAction, type WebServiceDeps } from "./web-service.js";
import {
  CLAIM_CODE_TTL_MS,
  claimLink,
  mintClaimCode,
} from "../../shared/claim-code.js";
import {
  FIXTURE_LABEL,
  fixtureLoginLink,
} from "../../shared/fixture-person.js";
import {
  FIXTURE_SETUP_SECRET_ENV_KEY,
  FROM_SETUP_SECRET_FLAG,
} from "../../shared/fixture-setup-secret.js";
import {
  personHereRefusal,
  terminalRefusal,
  type PersonHereDeps,
} from "../../shared/person-here.js";
import { redactSecrets } from "../../shared/redact.js";
import {
  checkAddress,
  cliLanguage,
  localIdentityKey,
  noticeLine,
  noticeOnce,
  upNoticeLines,
  upAddressLines,
  givenAddress,
  edgeUncheckedLine,
  isEdgeAddress,
  statedAddress,
  type AddressState,
  type CheckDeps,
} from "../../shared/edge/address-check.js";
import { localDateTime } from "../../shared/local-time.js";
import { writeFileAtomic } from "../../shared/atomic-write.js";
interface WebCommandOptions {
  /** `open` is `up` that always opens a fresh sign-in tab (SEC-1b). */
  action: "up" | "down" | "restart" | "open";
  port: number;
  openBrowser: boolean;
  silent: boolean;
  setupBrowserAccess: boolean;
}

interface StartedServer {
  pid: number | undefined;
  logPath: string;
  /** Where this start's output begins in the log. */
  logOffset?: number;
}

interface WebServerState {
  pid: number | undefined;
  port: number;
  root: string;
  logPath: string;
  startedAt: string;
  command: string;
}

interface StopServerResult {
  stopped: boolean;
  forced: boolean;
  pids: number[];
}

type BrowserFocusResult =
  | {
      status: "focused";
      app: string;
      /** The focused tab's URL (0.4.71: where its sign-in link goes back to). */
      url?: string;
    }
  | { status: "not-found" }
  | { status: "unsupported" }
  | { status: "error"; apps: string[]; error: string };

type BrowserOpenResult =
  | BrowserFocusResult
  | { status: "opened" }
  | { status: "open-failed"; error: string }
  | { status: "skipped"; why: string };

const WEB_START_POLL_MS = 250;

const BROWSER_APPS: Array<{
  name: string;
  kind: "chromium" | "safari";
}> = [
  { name: "Google Chrome", kind: "chromium" },
  { name: "Google Chrome Canary", kind: "chromium" },
  { name: "Microsoft Edge", kind: "chromium" },
  { name: "Brave Browser", kind: "chromium" },
  { name: "Arc", kind: "chromium" },
  { name: "Safari", kind: "safari" },
];

function configuredPort(): number {
  try {
    return readWebPort();
  } catch {
    return DEFAULT_PORT;
  }
}

function parsePort(value: string | undefined): number {
  const raw = value?.trim() || String(configuredPort());
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid web port: ${raw}`);
  }
  return port;
}

export function parseWebCommandArgs(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): WebCommandOptions {
  const options: WebCommandOptions = {
    action: "up",
    port: parsePort(env.PORT),
    // DEN_NO_OPEN=1 is --no-open (0.4.48: tests set it; nothing read it).
    openBrowser: env.DEN_NO_OPEN !== "1",
    silent: true,
    setupBrowserAccess: false,
  };
  let actionSeen = false;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (
      arg === "up" ||
      arg === "open" ||
      arg === "down" ||
      arg === "restart" ||
      arg === "start" || // legacy alias for up
      arg === "stop" // legacy alias for down
    ) {
      if (actionSeen) throw new Error("Only one web action may be specified");
      options.action = arg === "start" ? "up" : arg === "stop" ? "down" : arg;
      actionSeen = true;
      continue;
    }
    if (arg === "--no-open") {
      options.openBrowser = false;
      continue;
    }
    if (arg === "--setup-browser-access") {
      options.setupBrowserAccess = true;
      options.openBrowser = false;
      continue;
    }
    if (arg === "--verbose") {
      options.silent = false;
      continue;
    }
    if (arg === "--silent") {
      options.silent = true;
      continue;
    }
    if (arg === "--port" || arg === "-p") {
      const value = args[i + 1];
      if (!value || value.startsWith("-")) {
        throw new Error(`${arg} requires a value`);
      }
      options.port = parsePort(value);
      i += 1;
      continue;
    }
    if (arg.startsWith("--port=")) {
      options.port = parsePort(arg.slice("--port=".length));
      continue;
    }
    if (!arg.startsWith("-")) {
      throw new Error(`Unknown web action: ${arg}`);
    }
    throw new Error(`Unknown web option: ${arg}`);
  }

  if (options.action === "open") options.openBrowser = true;
  if (options.setupBrowserAccess && options.action !== "up") {
    throw new Error(
      `--setup-browser-access is only valid with ${product().cli} web up`,
    );
  }

  return options;
}

export function hasDenHostsEntry(hostsContent: string): boolean {
  return hostsContent.split(/\r?\n/).some((line) => {
    const withoutComment = line.split("#")[0]?.trim() ?? "";
    if (!withoutComment) return false;
    const parts = withoutComment.split(/\s+/);
    return (
      parts[0] === "127.0.0.1" && parts.slice(1).includes(`${product().cli}`)
    );
  });
}

function readHostsFile(): string {
  try {
    return fs.readFileSync("/etc/hosts", "utf-8");
  } catch {
    return "";
  }
}

export function resolveDenWebHost(hostsContent = readHostsFile()): string {
  return hasDenHostsEntry(hostsContent) ? `${product().cli}` : "localhost";
}

export function buildDenWebUrl(
  port: number,
  hostsContent = readHostsFile(),
): string {
  return `http://${resolveDenWebHost(hostsContent)}:${port}`;
}

/**
 * The address `web up` names: the bound one when DEN_BIND_HOST is a
 * specific address beyond loopback (a LAN-only bind doesn't answer on
 * localhost), else buildDenWebUrl's.
 */
export function webUpUrl(
  port: number,
  bind: string | undefined = process.env.DEN_BIND_HOST,
  hostsContent?: string,
): string {
  const to = webProbeTarget(bind, port);
  const loopback =
    to.host === "::1" || /^127\./.test(to.host) || to.host === "localhost";
  return loopback
    ? buildDenWebUrl(port, hostsContent)
    : `http://${to.hostHeader}`;
}

export function denWebUrlAliases(port: number): string[] {
  return [
    `http://${product().cli}:${port}`,
    `http://${product().cli}.localhost:${port}`,
    // eslint-disable-next-line no-restricted-syntax -- an address shown to a person, not dialled
    `http://localhost:${port}`,
    `http://127.0.0.1:${port}`,
  ];
}

export function isDenWebTabUrl(
  rawUrl: string,
  port: number,
  address: string | undefined = readWebUrl()?.url,
): boolean {
  try {
    const parsed = new URL(rawUrl);
    // D80: a tab on the install's address is this Den's too.
    if (address && parsed.origin === new URL(address).origin) return true;
    return (
      parsed.protocol === "http:" &&
      [
        `${product().cli}`,
        `${product().cli}.localhost`,
        "localhost",
        "127.0.0.1",
      ].includes(parsed.hostname) &&
      parsed.port === String(port)
    );
  } catch {
    return false;
  }
}

export { webProbeTarget };

async function getHttpText(
  port: number,
  requestPath: string,
  timeoutMs: number,
): Promise<{ statusCode: number; body: string } | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (
      value: { statusCode: number; body: string } | null,
    ): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const to = webProbeTarget(process.env.DEN_BIND_HOST, port);
    const req = http.get(
      {
        host: to.host,
        port,
        path: requestPath,
        timeout: timeoutMs,
        agent: false,
        setHost: false,
        // The CLI's bearer, as serverCall sends: an address beyond loopback
        // answers an unsigned probe 401 signin_required, never ready.
        headers: { host: to.hostHeader, ...cliAuthHeaders() },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf-8");
        res.on("data", (chunk: string) => {
          body += chunk;
          if (body.length > 1024 * 1024) {
            req.destroy();
            finish(null);
          }
        });
        res.on("end", () => {
          finish({ statusCode: res.statusCode ?? 0, body });
        });
      },
    );

    req.on("timeout", () => {
      req.destroy();
      finish(null);
    });
    req.on("error", () => finish(null));
  });
}

/**
 * The API is up: /api/server-info answers whatever the config holds
 * (0.3.0-dev.42: /api/health answers 422 under an invalid config, so
 * `web up` reported a running server as not ready). A server too old for
 * server-info is asked /api/health, as before.
 */
async function isDenWebApiRunning(
  port: number,
  probeMs: number,
): Promise<boolean> {
  const json = async (p: string): Promise<unknown> => {
    const response = await getHttpText(port, p, probeMs);
    if (!response || response.statusCode !== 200) return undefined;
    try {
      return JSON.parse(response.body) as unknown;
    } catch {
      return undefined;
    }
  };
  const info = await json("/api/server-info");
  if (
    info &&
    typeof info === "object" &&
    typeof (info as { pid?: unknown }).pid === "number"
  )
    return true;
  return Array.isArray(await json("/api/health"));
}

async function isDenWebUiReady(
  port: number,
  probeMs: number,
): Promise<boolean> {
  const response = await getHttpText(port, "/index.html", probeMs);
  return (
    // 422: the "Config is invalid" page, the shell serving as it should.
    (response?.statusCode === 200 || response?.statusCode === 422) &&
    /<html[\s>]/i.test(response.body) &&
    hasDenUiMarker(response.body)
  );
}

/** Den's web server answers on `port`; each probe waits `probeMs` (web.ready_probe_seconds). */
export async function isDenWebRunning(
  port: number,
  probeMs = webReadyWaits().probeMs,
): Promise<boolean> {
  return (
    (await isDenWebApiRunning(port, probeMs)) &&
    (await isDenWebUiReady(port, probeMs))
  );
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Why a server that just started refused to (its `✗ <reason>` line: the
 * bind refusal, a wrong web.session value), read from this start's part of
 * its log, secret-shaped values redacted. Null when it said none.
 */
export function startupRefusal(logPath: string, offset = 0): string | null {
  let text: string;
  try {
    const fd = fs.openSync(logPath, "r");
    try {
      const size = fs.fstatSync(fd).size;
      const from = Math.max(0, Math.min(offset, size), size - 64 * 1024);
      const buf = Buffer.alloc(size - from);
      fs.readSync(fd, buf, 0, buf.length, from);
      text = buf.toString("utf-8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
  const lines = text
    .split(/\r?\n/)
    .map((l) => /^\s*✗\s+(.+?)\s*$/.exec(l)?.[1])
    .filter((l): l is string => !!l);
  const last = lines.at(-1);
  return last ? redactSecrets(last).slice(0, 600) : null;
}

async function waitForDenWeb(port: number, pid?: number): Promise<boolean> {
  const { probeMs, startMs } = webReadyWaits();
  const deadline = Date.now() + startMs;
  while (Date.now() < deadline) {
    if (await isDenWebRunning(port, probeMs)) return true;
    // A server that refused to start has exited: no point waiting it out.
    if (pid !== undefined && !pidAlive(pid))
      return isDenWebRunning(port, probeMs);
    await new Promise((resolve) => setTimeout(resolve, WEB_START_POLL_MS));
  }
  return false;
}

/**
 * How to run the web server: Den's own files, from the engine root.
 *
 * The TypeScript source runs as `node --import <tsx loader> index.ts`, never
 * through the `tsx` CLI. The CLI is a parent process that relays signals to
 * the server and, if the server has not acknowledged a SIGTERM within about
 * 60ms (two 30ms windows), SIGKILLs it and exits 143. Under load the server
 * misses that window, so `<cli> web down` killed it without its shutdown.
 * With the loader there is one process, and the signal reaches the
 * server's own handler. (The launchd service, service/install.sh, already
 * runs this way.)
 */
export function resolveServerEntrypoint(engine: string = getEngineRoot()): {
  cmd: string;
  args: string[];
} {
  const builtServer = path.join(engine, "dist/src/ui/server/index.js");

  // Escape hatch: force the compiled build (e.g. to test the prod artifact).
  if (process.env.DEN_USE_DIST === "1" && fs.existsSync(builtServer)) {
    return { cmd: process.execPath, args: [builtServer] };
  }

  // Prefer live TypeScript source in a dev checkout (tsx present). A built dist/
  // is gitignored and only refreshed by `npm run build`, so preferring it
  // silently runs a stale server AND serves stale web assets
  // (dist/src/ui/server/public) — the footgun that makes UI edits appear not to
  // take effect. The server resolves PUBLIC_DIR relative to its own module, so
  // running from src/ serves src/ui/server/public directly. Fall back to the
  // compiled build only when devDependencies (tsx) aren't installed.
  const loader = engineModuleFile("tsx/dist/loader.mjs", engine);
  const srcServer = path.join(engine, "src/ui/server/index.ts");
  if (loader && fs.existsSync(srcServer)) {
    return {
      cmd: process.execPath,
      args: ["--import", pathToFileURL(loader).href, srcServer],
    };
  }

  if (fs.existsSync(builtServer)) {
    return { cmd: process.execPath, args: [builtServer] };
  }

  return {
    cmd: engineBin(process.platform === "win32" ? "tsx.cmd" : "tsx", engine),
    args: [srcServer],
  };
}

/**
 * The env the web server daemon starts with: the caller's, its port, and
 * whatever the selected secrets strategy gives (only 1password gives one,
 * OP_ACCOUNT, from the distribution's `secrets.onepassword.account` or the
 * caller's own OP_ACCOUNT). Den adds no account of its own.
 */
export function webServerEnv(
  port: number,
  base: NodeJS.ProcessEnv = process.env,
  cfg: SecretsConfig = readSecretsConfig(),
): NodeJS.ProcessEnv {
  return { ...base, PORT: String(port), ...secretsProcessEnv(cfg, base) };
}

function startDenWebServer(options: WebCommandOptions): StartedServer {
  const root = getDistRoot();
  const entrypoint = resolveServerEntrypoint();
  const logDir = path.join(getStateDir(), "logs", `${product().cli}`);
  fs.mkdirSync(logDir, { recursive: true });
  const logPath = path.join(logDir, "web.log");
  fs.appendFileSync(
    logPath,
    `\n--- ${product().cli} web start ${new Date().toISOString()} ---\n`,
  );

  const logOffset = fs.statSync(logPath).size;
  const logFd = fs.openSync(logPath, "a");
  try {
    const child = spawn(
      entrypoint.cmd,
      [...entrypoint.args, ...(options.silent ? ["--silent"] : [])],
      {
        cwd: root,
        detached: true,
        env: webServerEnv(options.port),
        stdio: ["ignore", logFd, logFd],
      },
    );
    child.unref();
    const started = { pid: child.pid, logPath, logOffset };
    writeWebServerState({
      ...started,
      port: options.port,
      root,
      startedAt: new Date().toISOString(),
      command: `${entrypoint.cmd} ${[
        ...entrypoint.args,
        ...(options.silent ? ["--silent"] : []),
      ].join(" ")}`,
    });
    return started;
  } finally {
    fs.closeSync(logFd);
  }
}

/**
 * How to run this Den's CLI, as the server runs it: this node with tsx's
 * loader (or the built CLI). SRV-1b's update reuses it for doctor and the
 * rollback's restart.
 */
export function denCliCommand(): { cmd: string; baseArgs: string[] } {
  const engine = getEngineRoot();
  const tsxBin = engineBin(process.platform === "win32" ? "tsx.cmd" : "tsx");
  const srcCli = path.join(engine, "src/ui/cli/index.ts");
  const builtCli = path.join(engine, "dist/src/ui/cli/index.js");

  let cmd: string;
  let baseArgs: string[];
  // SRV-1a: this node, with tsx's loader, as resolveServerEntrypoint runs
  // the server: never the tsx bin, whose `#!/usr/bin/env node` needs node
  // on PATH (a launchd service's PATH may not have it; the restart then
  // died at once and Den stayed down).
  const loader = engineModuleFile("tsx/dist/loader.mjs", engine);
  if (process.env.DEN_USE_DIST === "1" && fs.existsSync(builtCli)) {
    cmd = process.execPath;
    baseArgs = [builtCli];
  } else if (loader && fs.existsSync(srcCli)) {
    cmd = process.execPath;
    baseArgs = ["--import", pathToFileURL(loader).href, srcCli];
  } else if (fs.existsSync(tsxBin) && fs.existsSync(srcCli)) {
    cmd = tsxBin;
    baseArgs = [srcCli];
  } else if (fs.existsSync(builtCli)) {
    cmd = process.execPath;
    baseArgs = [builtCli];
  } else {
    cmd = tsxBin;
    baseArgs = [srcCli];
  }
  return { cmd, baseArgs };
}

/**
 * Spawn `den web restart` as a DETACHED child so a running server can
 * restart ITSELF (e.g. from the "stale server" UI): the child stops whatever is
 * listening on `port` — the current server — then starts a fresh daemon,
 * surviving the current process's death. Returns the short-lived driver pid.
 * Mirrors resolveServerEntrypoint's preference for live tsx source.
 */
export function spawnDetachedWebRestart(port: number): number | undefined {
  const root = getDistRoot();
  const { cmd, baseArgs } = denCliCommand();

  const logDir = path.join(getStateDir(), "logs", `${product().cli}`);
  fs.mkdirSync(logDir, { recursive: true });
  const logFd = fs.openSync(path.join(logDir, "web.log"), "a");
  try {
    const child = spawn(
      cmd,
      [...baseArgs, "web", "restart", "--no-open", "--port", String(port)],
      {
        cwd: root,
        detached: true,
        env: webServerEnv(port),
        stdio: ["ignore", logFd, logFd],
      },
    );
    child.unref();
    return child.pid;
  } finally {
    fs.closeSync(logFd);
  }
}

function webServerStatePath(): string {
  return path.join(getStateDir(), "web.json");
}

function readWebServerState(): WebServerState | null {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(webServerStatePath(), "utf-8"),
    ) as Partial<WebServerState>;
    if (
      typeof parsed.pid !== "number" ||
      !Number.isInteger(parsed.pid) ||
      typeof parsed.port !== "number" ||
      !Number.isInteger(parsed.port)
    ) {
      return null;
    }
    if (typeof parsed.root !== "string" || typeof parsed.logPath !== "string") {
      return null;
    }
    return {
      pid: parsed.pid,
      port: parsed.port,
      root: parsed.root,
      logPath: parsed.logPath,
      startedAt: typeof parsed.startedAt === "string" ? parsed.startedAt : "",
      command: typeof parsed.command === "string" ? parsed.command : "",
    };
  } catch {
    return null;
  }
}

function writeWebServerState(state: WebServerState): void {
  const statePath = webServerStatePath();
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  writeFileAtomic(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

function removeWebServerState(): void {
  try {
    fs.unlinkSync(webServerStatePath());
  } catch {
    /* absent or already removed */
  }
}

/** Throws LookupTimeoutError when lsof can't answer (proc-lookup.ts). */
function listListeningPids(port: number): number[] {
  const out = lookup("lsof", [`-tiTCP:${port}`, "-sTCP:LISTEN"]);
  return Array.from(
    new Set(
      out
        .split(/\r?\n/)
        .map((line) => Number(line.trim()))
        .filter((pid) => Number.isInteger(pid) && pid > 0),
    ),
  );
}

/** Throws LookupTimeoutError when ps can't answer (proc-lookup.ts). */
function commandForPid(pid: number): string {
  return lookup("ps", ["-p", String(pid), "-o", "command="]).trim();
}

/**
 * Whether `command` is this Den web server: its entry point, run from one of
 * `roots` — the distribution root (an npm install lives under it) or the
 * engine root (a linked checkout, `npm i ../den`, lives outside it).
 */
export function isDenWebCommand(
  command: string,
  roots: string[] = webRoots(),
): boolean {
  const hasServerEntrypoint =
    command.includes("src/ui/server/index.ts") ||
    command.includes("dist/src/ui/server/index.js");
  if (!hasServerEntrypoint) return false;
  return roots.some((r) => command.includes(path.resolve(r)));
}

function webRoots(root: string = getDistRoot()): string[] {
  const roots = [root];
  try {
    roots.push(getEngineRoot());
  } catch {
    /* no engine root found: the distribution root alone */
  }
  return roots;
}

async function waitForPortRelease(port: number): Promise<boolean> {
  const deadline = Date.now() + CLI_SPAWN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      if (listListeningPids(port).length === 0) return true;
    } catch (err) {
      // Couldn't tell: not released yet, as far as we know.
      if (!(err instanceof LookupTimeoutError)) throw err;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return false;
}

async function waitForPidsExit(pids: number[]): Promise<boolean> {
  const deadline = Date.now() + CLI_SPAWN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const anyAlive = pids.some((pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    });
    if (!anyAlive) return true;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return false;
}

/**
 * Whether `pid` may be this distribution's server by where it runs: a web
 * server runs from its distribution root, so one whose working directory
 * is another root is never ours, even when its command line matches (two
 * distributions on one linked engine run the same entry point). An
 * unreadable directory does not decide.
 */
function runsFromRoot(pid: number, root: string): boolean {
  const cwd = processCwd(pid);
  if (!cwd) return true;
  return samePath(cwd, root);
}

function isOurWebPid(pid: number, root: string): boolean {
  const command = commandForPid(pid);
  return (
    !!command &&
    isDenWebCommand(command, webRoots(root)) &&
    runsFromRoot(pid, root)
  );
}

/**
 * Our server's pids on `port`. `vouched` is the pid of a server the
 * identity check (server-info: our root, or an older server run from our
 * root) found ours: it is stopped when it listens on the port even if its
 * command line names no entry point we recognise. Before, an older Den
 * installed elsewhere, or a hand-started server, matched no command line,
 * so `web down` said "not running" and `web restart` "already running".
 */
function findDenWebPids(port: number, vouched?: number): number[] {
  const root = getDistRoot();
  const pids = new Set<number>();
  const state = readWebServerState();
  const listeners = listListeningPids(port);
  // The state file may be shared by distributions of one product name: a
  // record of another root's server is not ours to stop.
  if (
    state?.port === port &&
    state.pid &&
    samePath(state.root || root, root) &&
    (isOurWebPid(state.pid, root) ||
      (state.pid === vouched && listeners.includes(state.pid)))
  ) {
    pids.add(state.pid);
  }

  for (const pid of listeners) {
    if (pid === vouched || isOurWebPid(pid, root)) pids.add(pid);
  }

  return Array.from(pids);
}

/**
 * Signal a den-web process AND its process group. The server is spawned with
 * `detached: true` (a process-group leader) and spawns `tail -F` log streamers
 * as children in that group; signalling only the server pid leaves those tails
 * orphaned (reparented to init, `tail -F` runs forever). Signal the whole group
 * (negative pid) first, then the pid itself as a fallback. Detached daemon
 * SERVICES are their own group leaders, so they're untouched — only the web
 * server and its streamers stop.
 */
export function killWebProcess(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal); // whole process group
  } catch {
    /* not a group leader, or already gone */
  }
  try {
    process.kill(pid, signal);
  } catch {
    /* already gone */
  }
}

async function stopDenWebServer(
  port: number,
  vouched?: number,
): Promise<StopServerResult> {
  const pids = findDenWebPids(port, vouched);
  if (pids.length === 0) {
    const state = readWebServerState();
    if (state?.port === port) removeWebServerState();
    return { stopped: false, forced: false, pids: [] };
  }

  for (const pid of pids) killWebProcess(pid, "SIGTERM");

  const graceful =
    (await waitForPidsExit(pids)) && (await waitForPortRelease(port));
  if (graceful) {
    removeWebServerState();
    return { stopped: true, forced: false, pids };
  }

  for (const pid of pids) killWebProcess(pid, "SIGKILL");

  const forced =
    (await waitForPidsExit(pids)) && (await waitForPortRelease(port));
  if (forced) removeWebServerState();
  return { stopped: forced, forced: true, pids };
}

async function stopBrokenDenWebServer(
  port: number,
  vouched?: number,
): Promise<boolean> {
  return (await stopDenWebServer(port, vouched)).stopped;
}

function recordRunningDenWebServer(port: number): void {
  const root = getDistRoot();
  const state = readWebServerState();
  if (
    state?.port === port &&
    state.pid &&
    samePath(state.root || root, root) &&
    isOurWebPid(state.pid, root)
  )
    return;

  const pids = listListeningPids(port).filter((pid) => isOurWebPid(pid, root));
  const pid = pids[0];
  if (!pid) return;

  const logPath = path.join(
    getStateDir(),
    "logs",
    `${product().cli}`,
    "web.log",
  );
  writeWebServerState({
    pid,
    port,
    root,
    logPath,
    startedAt: new Date().toISOString(),
    command: commandForPid(pid),
  });
}

function appleScriptString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function appleScriptUrlPredicate(varName: string, port: number): string {
  // D80: the install's address first: the tab a person has open.
  const address = readWebUrl()?.url;
  return [...(address ? [address] : []), ...denWebUrlAliases(port)]
    .flatMap((url) => [
      `${varName} is ${appleScriptString(url)}`,
      `${varName} starts with ${appleScriptString(`${url}/`)}`,
      `${varName} starts with ${appleScriptString(`${url}?`)}`,
    ])
    .join(" or ");
}

function buildChromiumFocusScript(appName: string, port: number): string {
  const predicate = appleScriptUrlPredicate("u", port);
  return `
if application ${appleScriptString(appName)} is running then
  tell application ${appleScriptString(appName)}
    repeat with w in windows
      set tabIndex to 0
      repeat with t in tabs of w
        set tabIndex to tabIndex + 1
        set u to URL of t
        if u is not missing value and (${predicate}) then
          set active tab index of w to tabIndex
          set index of w to 1
          activate
          return "focused " & u
        end if
      end repeat
    end repeat
    return "not-found"
  end tell
end if
return "not-running"
`;
}

function buildSafariFocusScript(port: number): string {
  const predicate = appleScriptUrlPredicate("u", port);
  return `
if application "Safari" is running then
  tell application "Safari"
    repeat with w in windows
      repeat with t in tabs of w
        set u to URL of t
        if u is not missing value and (${predicate}) then
          set current tab of w to t
          set index of w to 1
          activate
          return "focused " & u
        end if
      end repeat
    end repeat
    return "not-found"
  end tell
end if
return "not-running"
`;
}

function runAppleScript(
  script: string,
  timeout = CLI_SPAWN_TIMEOUT_MS,
): string {
  return execFileSync("/usr/bin/osascript", [], {
    input: script,
    encoding: "utf-8",
    timeout,
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

function focusExistingBrowserTab(port: number): BrowserFocusResult {
  if (process.platform !== "darwin") return { status: "unsupported" };

  let inspectedBrowser = false;
  const failedApps: string[] = [];
  let firstError = "";

  for (const app of BROWSER_APPS) {
    let result = "not-found";
    try {
      result = runAppleScript(
        app.kind === "safari"
          ? buildSafariFocusScript(port)
          : buildChromiumFocusScript(app.name, port),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failedApps.push(app.name);
      firstError ||= message;
      continue;
    }

    if (result === "focused" || result.startsWith("focused "))
      return {
        status: "focused",
        app: app.name,
        ...(result.length > 8 ? { url: result.slice(8) } : {}),
      };
    if (result === "not-found") inspectedBrowser = true;
  }

  if (!inspectedBrowser && failedApps.length > 0) {
    return { status: "error", apps: failedApps, error: firstError };
  }

  return { status: "not-found" };
}

/**
 * 0.4.71: send the tab focusTab just brought forward to `url` (its sign-in
 * link). False when it can't (the browser said no, or isn't scriptable).
 */
function navigateFocusedTab(app: string, url: string): boolean {
  if (process.platform !== "darwin") return false;
  const kind = BROWSER_APPS.find((a) => a.name === app)?.kind;
  if (!kind) return false;
  const tab =
    kind === "safari"
      ? "current tab of front window"
      : "active tab of front window";
  try {
    runAppleScript(
      `tell application ${appleScriptString(app)} to set URL of ${tab} to ${appleScriptString(url)}`,
    );
    return true;
  } catch {
    return false;
  }
}

/** The path, query and hash of a tab's URL, for its sign-in's `next`. */
function tabNext(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    // An open sign-in or auth page goes home after, not back to itself.
    if (u.pathname === "/auth" || u.pathname === "/signin") return "/";
    return u.pathname + u.search + u.hash;
  } catch {
    return undefined;
  }
}

/** Where a Linux system keeps xdg-open (never the caller's PATH). */
const XDG_OPEN_PATHS = [
  "/usr/bin/xdg-open",
  "/usr/local/bin/xdg-open",
  "/bin/xdg-open",
];

/**
 * Sign-in: the program that opens the browser, by absolute path: macOS's
 * /usr/bin/open, the first xdg-open of a fixed system list elsewhere (null
 * when there is none). Windows: its own cmd.exe.
 */
export function browserOpener(
  platform: NodeJS.Platform = process.platform,
  exists: (p: string) => boolean = (p) => fs.existsSync(p),
): string | null {
  if (platform === "darwin") return "/usr/bin/open";
  if (platform === "win32")
    return `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\cmd.exe`;
  return XDG_OPEN_PATHS.find(exists) ?? null;
}

let OPENER: string | null | undefined;

function openUrl(url: string): BrowserOpenResult {
  // Resolved once per run.
  if (OPENER === undefined) OPENER = browserOpener();
  const cmd = OPENER;
  if (!cmd) return { status: "open-failed", error: "no browser opener found" };
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const result = spawnSync(cmd, args, {
    stdio: "ignore",
    timeout: CLI_SPAWN_TIMEOUT_MS,
  });
  if (result.status === 0) return { status: "opened" };
  const error =
    result.error?.message ??
    `browser opener exited with status ${result.status ?? "unknown"}`;
  return { status: "open-failed", error };
}

/**
 * Focus a tab already on this server, else open `url()` (SEC-1b: the
 * sign-in link, minted only when it is opened). `focus: false` (`web
 * open`) always opens. 0.4.71: a focused tab is sent to a fresh link too,
 * back to the page it was on, so it is signed in whatever it held; when
 * it can't be, the link opens in a new tab.
 */
export function openOrFocusDenWebUrl(
  url: (next?: string) => string,
  port: number,
  focus = true,
  /** A test's stubs; the env says whether it may open at all. */
  deps: {
    focus?: (port: number) => BrowserFocusResult;
    navigate?: (app: string, url: string) => boolean;
    open?: (url: string) => BrowserOpenResult;
    env?: NodeJS.ProcessEnv;
  } = {},
): BrowserOpenResult {
  // 0.4.48: never under a test or CI run (browser-open.ts); nothing is
  // focused, opened or minted.
  const why = browserOpenRefusal(deps.env ?? process.env);
  if (why) return { status: "skipped", why };
  if (focus) {
    const focusResult = (deps.focus ?? focusExistingBrowserTab)(port);
    if (focusResult.status === "focused") {
      const link = url(tabNext(focusResult.url));
      // Inside an agent's session the "link" is the plain page: the
      // focused tab stays as it is.
      if (!/\/auth\?/.test(link))
        return { status: "focused", app: focusResult.app };
      if ((deps.navigate ?? navigateFocusedTab)(focusResult.app, link))
        return { status: "focused", app: focusResult.app };
      return (deps.open ?? openUrl)(link);
    }

    if (focusResult.status === "error" && process.platform === "darwin") {
      return focusResult;
    }
  }

  return (deps.open ?? openUrl)(url());
}

function buildBrowserAccessProbeScript(appName: string): string {
  return `
if application ${appleScriptString(appName)} is running then
  tell application ${appleScriptString(appName)}
    get count of windows
  end tell
  return "granted"
end if
return "not-running"
`;
}

function detectTerminalBundleId(): string | null {
  const termProgram = process.env.TERM_PROGRAM ?? "";
  if (termProgram === "iTerm.app") return "com.googlecode.iterm2";
  if (termProgram === "Apple_Terminal") return "com.apple.Terminal";
  if (termProgram === "vscode") return "com.microsoft.VSCode";
  return null;
}

function automationResetHint(): string {
  const bundleId = detectTerminalBundleId();
  if (bundleId) return `tccutil reset AppleEvents ${bundleId}`;
  return "tccutil reset AppleEvents";
}

function isAutomationDenied(error: string): boolean {
  return /-1743|not authorized|not permitted|not allowed/i.test(error);
}

function setupBrowserAccess(): void {
  if (process.platform !== "darwin") {
    console.log(
      chalk.yellow("\n  Browser tab reuse is only automated on macOS.\n"),
    );
    return;
  }

  console.log(chalk.cyan("\n  Requesting browser tab access..."));
  console.log(
    chalk.gray(
      `  Keep the browser you use for ${product().title} open and approve the macOS Automation prompt if it appears.`,
    ),
  );

  let runningBrowsers = 0;
  let grantedBrowsers = 0;
  let deniedBrowsers = 0;

  for (const app of BROWSER_APPS) {
    try {
      const result = runAppleScript(
        buildBrowserAccessProbeScript(app.name),
        60_000,
      );
      if (result === "not-running") continue;

      runningBrowsers += 1;
      grantedBrowsers += 1;
      console.log(chalk.green(`  OK ${app.name} access granted`));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      runningBrowsers += 1;
      deniedBrowsers += 1;
      console.log(chalk.yellow(`  WARN ${app.name} access was not granted`));
      if (!isAutomationDenied(message)) {
        console.log(chalk.gray(`       ${message}`));
      }
    }
  }

  if (runningBrowsers === 0) {
    console.log(
      chalk.yellow(
        "\n  No supported running browser was found. Open Chrome, Safari, Edge, Brave, or Arc, then rerun:",
      ),
    );
    console.log(chalk.gray(`  ${product().cli} web --setup-browser-access\n`));
    return;
  }

  if (grantedBrowsers > 0 && deniedBrowsers === 0) {
    console.log(
      chalk.green(
        `\n  OK Browser access is ready. \`${product().cli} web\` can now reuse an existing tab.\n`,
      ),
    );
    return;
  }

  console.log(
    chalk.yellow(
      `\n  macOS did not grant access for every running browser ${product().title} checked.`,
    ),
  );
  console.log(
    chalk.gray(
      "  Open System Settings -> Privacy & Security -> Automation and allow your terminal to control your browser.",
    ),
  );
  console.log(
    chalk.gray(
      "  If no prompt appeared, reset the terminal's AppleEvents permission and rerun setup:",
    ),
  );
  console.log(chalk.gray(`  ${automationResetHint()}`));
  console.log(chalk.gray(`  ${product().cli} web --setup-browser-access\n`));
}

/** `web` subcommands that answer their own --help (cmdWeb dispatches them first). */
export const WEB_SUBCOMMANDS_WITH_HELP = [
  "token",
  "login",
  "sessions",
  "logout",
  "owner",
  "approve",
  "claim-link",
  "url",
  "fixture-person",
  "fixture-login",
] as const;

export function displayWebHelp(): void {
  console.log(chalk.bold("\nUsage:"));
  console.log(
    `  ${product().cli} web [up|down|restart] [--port <port>] [--no-open] [--verbose]`,
  );
  console.log(`  ${product().cli} web --setup-browser-access`);
  console.log(`  ${product().cli} web token --print`);
  console.log(
    `  ${product().cli} web login [--next <path>] [--host <name> | --origin <url>] [--no-wait] [--port <port>]`,
  );
  console.log(`  ${product().cli} web sessions [--json] [--port <port>]`);
  console.log(
    `  ${product().cli} web logout [<id prefix>] [--all] [--port <port>]`,
  );
  console.log(`  ${product().cli} web owner [link|show|unlink] [--json]`);
  console.log(`  ${product().cli} web url [<address>] [--json]`);
  console.log(`  ${product().cli} web approve --list [--json] [--port <port>]`);
  console.log(`  ${product().cli} web fixture-person`);
  console.log(
    `  ${product().cli} web fixture-login [--next <path>] [--origin <url>]`,
  );
  console.log();
  console.log(chalk.bold("Actions:"));
  console.log(
    `  up                 Start or focus ${product().title} web (default)`,
  );
  console.log(
    `  down               Stop the ${product().title} web daemon only`,
  );
  console.log(`  restart            Stop then start ${product().title} web`);
  console.log(
    "  open               Start if needed, and sign this browser in (a new tab)",
  );
  console.log(
    "  login              Print a one-time sign-in link (5 min; web.login_link_ttl), then wait until it's used or approved",
  );
  console.log("  sessions           List the signed-in browsers");
  console.log(
    "  logout [<id>]      Sign out one browser, or all; --all also rotates web.secret and revokes agent tokens",
  );
  console.log(
    "  token --print      Print your CLI token, for curl (Authorization: Bearer …)",
  );
  console.log(
    "  owner link         Link your GitHub account as this Den's owner (Sign in with GitHub)",
  );
  console.log(
    "  approve --list     List the computers waiting; approve them in a signed-in browser (Settings › Access)",
  );
  console.log(
    "  claim-link         Print a one-time setup link (30 min) that signs this machine's browser in",
  );
  console.log(
    "  url [<address>]    Show or set this install's address (web.url), the one people are given",
  );
  console.log("  (start/stop remain accepted as legacy aliases for up/down)");
  console.log();
  console.log(chalk.bold("Options:"));
  console.log("  --port, -p <port>  Use a non-default web port");
  console.log(
    "  --no-open          Start or check the server without opening a browser",
  );
  console.log(
    "  --json             log on stderr; stdout: up, restart { ok, url, port, version? }; down { ok, url, port, running, stopped }",
  );
  console.log(
    "  --setup-browser-access  Request macOS Automation access for browser tab reuse",
  );
  console.log(
    "  --verbose          Keep verbose server request logging enabled",
  );
  console.log(
    "  --silent           Suppress verbose server request logging (default)",
  );
  console.log();
}

/**
 * `<cli> web token --print` (SEC-1a): the person token, for curl. The token
 * alone on stdout; a one-line note on stderr that it grants the user's
 * access. Creates web.secret on first need.
 */
export function cmdWebToken(args: string[], io: CliIo = stdIo): number {
  const usage =
    `Usage: ${product().cli} web token --print\n` +
    "  Prints the token that authorizes your CLI's calls to the web server.\n";
  if (isHelp(args)) {
    io.out(usage);
    return 0;
  }
  const rest = args.filter((a) => a !== "--print");
  if (!args.includes("--print") || rest.length > 0) {
    io.err(usage);
    return 2;
  }
  // Sign-in: the token is the person's, printed only to their terminal.
  const refused = printRefusal(io);
  if (refused) {
    io.err(`${product().cli}: ${refused}\n`);
    return 1;
  }
  const secret = ensureWebSecret(io.stateDir ?? getStateDir());
  io.err(
    `${product().cli}: this token grants your access (person:${osUser()}) to ` +
      `${product().title} web; keep it out of logs and shared shells.\n`,
  );
  io.out(`${personToken(secret)}\n`);
  return 0;
}

/** Tests: the launchd service seams (web-service.ts); never the real launchctl. */
let webServiceDeps: WebServiceDeps | undefined;
export function setWebServiceDepsForTest(d: WebServiceDeps | undefined): void {
  webServiceDeps = d;
}

export async function cmdWeb(args: string[]): Promise<void> {
  try {
    await runWeb(args);
  } catch (err) {
    // A lookup that never answered (proc-lookup.ts): say so, the same way
    // for down, restart and up (0.4.29-dev.2's gate).
    if (!(err instanceof LookupTimeoutError)) throw err;
    let port = DEFAULT_PORT;
    try {
      port = parseWebCommandArgs(args).port;
    } catch {
      /* the default */
    }
    throw new Error(couldntTell(port, err));
  }
}

/** "Couldn't tell whether … is running on port N: lsof took too long …". */
export function couldntTell(port: number, err: LookupTimeoutError): string {
  return `Couldn't tell whether ${product().title} web is running on port ${port}: ${err.message}. The machine may be busy; run it again.`;
}

async function runWeb(args: string[]): Promise<void> {
  // A subcommand with its own help answers its own --help (it is
  // dispatched first); the rest (up, down, restart, open) share this one.
  if (args[0] === "token") {
    process.exitCode = cmdWebToken(args.slice(1));
    return;
  }
  if (args[0] === "login") {
    process.exitCode = await cmdWebLoginWait(args.slice(1));
    return;
  }
  if (args[0] === "sessions") {
    process.exitCode = await cmdWebSessions(args.slice(1));
    return;
  }
  if (args[0] === "logout") {
    process.exitCode = await cmdWebLogout(args.slice(1));
    return;
  }
  if (args[0] === "owner") {
    process.exitCode = await cmdWebOwner(args.slice(1));
    return;
  }
  if (args[0] === "approve") {
    process.exitCode = await cmdWebApprove(args.slice(1));
    return;
  }
  if (args[0] === "claim-link") {
    process.exitCode = cmdWebClaimLink(args.slice(1));
    return;
  }
  if (args[0] === "url") {
    process.exitCode = await cmdWebUrl(args.slice(1));
    return;
  }
  if (args[0] === "fixture-person") {
    process.exitCode = await cmdWebFixturePerson(args.slice(1));
    return;
  }
  if (args[0] === "fixture-login") {
    process.exitCode = await cmdWebFixtureLogin(args.slice(1));
    return;
  }
  if (args.includes("--help") || args.includes("-h")) {
    displayWebHelp();
    return;
  }

  const options = parseWebCommandArgs(args);
  if (options.setupBrowserAccess) {
    setupBrowserAccess();
    return;
  }

  // Probes and signals use the loopback address (webProbeTarget); what a
  // person reads and opens is the install's address (D80), never localhost.
  const addr = readWebUrl();
  const shown = addr?.url ?? `(${notSetLine(product().cli)})`;

  // Never act on another distribution's server: not "already running", and
  // never a signal to it (down, restart).
  const identity = await refuseForeignServer(options.port, ownServer());
  const vouched = identity.kind === "ours" ? identity.pid : undefined;

  // With the launchd service installed, it owns the server: restart and up
  // go through launchd, down is refused (launchd would start it again).
  const svc = await webServiceAction(
    options.action,
    options.port,
    identity.kind === "ours",
    (p) => waitForDenWeb(p),
    webServiceDeps,
  );
  if (svc.handled) {
    if (svc.code !== 0) {
      process.exitCode = svc.code;
      return;
    }
    recordRunningDenWebServer(options.port);
  }

  if (svc.handled) {
    /* the service runs it: on to opening the browser */
  } else if (options.action === "down") {
    const stopped = await stopDenWebServer(options.port, vouched);
    if (stopped.stopped) {
      const mode = stopped.forced ? "force stopped" : "stopped";
      console.log(
        chalk.green(
          `\n  OK ${product().title} web ${mode} (${stopped.pids.join(", ")})\n`,
        ),
      );
      return;
    }
    if (stopped.pids.length > 0) {
      throw new Error(
        `Could not stop ${product().title} web on port ${options.port}. See ~/.${product().name}/logs/${product().cli}/web.log`,
      );
    }
    console.log(
      chalk.green(`\n  OK ${product().title} web is not running at ${shown}\n`),
    );
    return;
  }

  // D17: whoever starts it can connect their GitHub account from any
  // browser (web.owner_github, from gh), before the server reads it.
  if (options.action === "up" || options.action === "restart") {
    const line = ownerGithubLine(recordOwnerGithub(), product().cli);
    if (line) console.log(chalk.dim(`\n  ${line}`));
  }

  if (options.action === "restart" && !svc.handled) {
    const stopped = await stopDenWebServer(options.port, vouched);
    if (stopped.pids.length > 0 && !stopped.stopped) {
      throw new Error(
        `Could not stop ${product().title} web on port ${options.port}.`,
      );
    }
    const status = stopped.stopped
      ? stopped.forced
        ? "force stopped"
        : "stopped"
      : "not running";
    console.log(
      chalk.gray(`\n  ${product().title} web ${status}; starting again...`),
    );
  }

  // SEC-1b: a wrong web.allow_plain_http_remote would stop the server at
  // start; say so here, naming the key, instead of "did not become ready".
  // A key read and ignored (the distribution's web.allow_plain_http_remote:
  // only user.yml counts) is said here too, not only in the server's log.
  const ignored = ignoredConfigWarning(
    readWebAuthConfig(getDistRoot(), product().configFile),
  );
  if (ignored) console.log(chalk.yellow(`\n  ⚠ ${ignored}`));

  const { probeMs } = webReadyWaits();
  const apiRunning =
    svc.handled || (await isDenWebApiRunning(options.port, probeMs));
  let running =
    svc.handled ||
    (apiRunning && (await isDenWebUiReady(options.port, probeMs)));
  let started: StartedServer | null = null;

  if (apiRunning && !running) {
    console.log(
      chalk.yellow(
        `\n  Existing ${product().title} web server on ${shown} is responding, but the UI assets are not available.`,
      ),
    );
    console.log(chalk.gray(`  Restarting ${product().title} web...`));
    const stopped = await stopBrokenDenWebServer(options.port, vouched);
    if (!stopped) {
      throw new Error(
        `Could not stop the broken ${product().title} web server on port ${options.port}.`,
      );
    }
  }

  if (!running) {
    // D20: started from an ssh (Background) shell, it lives there.
    const where = webUpWarning(launchdSession(), product().cli);
    if (where) console.log(chalk.yellow(`\n  ⚠ ${where}`));
    // Issue 455: no address yet; it is said once it is proven.
    console.log(
      chalk.cyan(
        `\n  Starting ${product().cli} web on port ${options.port}...`,
      ),
    );
    try {
      started = startDenWebServer(options);
      running = await waitForDenWeb(options.port, started.pid);
      if (!running) {
        // The server's own reason, when it gave one, then where to look.
        const why = startupRefusal(started.logPath, started.logOffset);
        throw new Error(
          why
            ? `${product().title} web refused to start: ${why}\n  See ${started.logPath}`
            : `${product().title} web did not become ready. See ${started.logPath}`,
        );
      }
      console.log(
        chalk.green(
          `  OK ${product().title} web started${started.pid ? ` (pid ${started.pid})` : ""}`,
        ),
      );
      console.log(chalk.gray(`  Log: ${started.logPath}`));
    } catch (error) {
      console.log(chalk.red(`  ERROR Failed to start ${product().cli} web`));
      throw error;
    }
  } else if (!svc.handled) {
    recordRunningDenWebServer(options.port);
  }

  // Issue 455: only an address just proven to reach this Den is printed or
  // opened. When the install's address isn't Den (another server holds its
  // port), Den's own port here, said once per change with what holds it.
  const proven = addr
    ? await checkAddress({
        webPort: options.port,
        wanted: addr.url,
        key: localIdentityKey(getStateDir()),
        cli: product().cli,
      })
    : null;
  // When web.url is the edge address and it hasn't answered as this Den
  // (nothing answers, another server does, or no answer in time), Visit
  // and what opens are the checked address, as doctor and web.log give it,
  // and one line names the edge address as not checked yet. Once it is
  // proven, it is the address (D80).
  const said =
    proven && addr ? statedAddress(proven, isEdgeAddressHere(addr.url)) : null;
  const origin =
    (said?.unchecked ? said.address : null) ??
    (proven ? givenAddress(proven) : null) ??
    addr?.url ??
    null;
  const shownNow = origin ?? shown;
  if (running && !svc.handled && !started)
    console.log(
      chalk.green(
        `\n  OK ${product().title} web is already running at ${shownNow}`,
      ),
    );
  // Nothing answers the address: said plainly, next to the checked one.
  if (proven && addr)
    for (const l of upAddressLines(
      proven,
      { lang: cliLanguage(), title: product().title, cli: product().cli },
      edgeDownFor(addr.url),
    ))
      console.log(chalk.yellow(`  ! ${l}`));
  if (said?.unchecked)
    console.log(
      chalk.gray(
        `  ${edgeUncheckedLine(said.unchecked, {
          lang: cliLanguage(),
          title: product().title,
          cli: product().cli,
        })}`,
      ),
    );
  if (proven?.address && addr && proven.address !== addr.url) {
    const words = {
      lang: cliLanguage(),
      title: product().title,
      cli: product().cli,
    };
    if (noticeOnce(getStateDir(), proven))
      for (const [i, l] of upNoticeLines(proven, words, null).entries())
        console.log(
          i === 0 ? chalk.yellow(`  ! ${l}`) : chalk.gray(`    ${l}`),
        );
  }

  if (!options.openBrowser) {
    console.log(chalk.gray(`  Browser open skipped. Visit: ${shownNow}\n`));
    return;
  }
  if (!addr || !origin) {
    // D80: nothing to open until the install has its address.
    console.log(chalk.yellow(`  Nothing opened: ${shown.slice(1, -1)}\n`));
    return;
  }

  // SEC-1b: what opens is a sign-in link (localhost, one-time, D16:
  // web.login_link_ttl). It
  // is printed only when the browser couldn't be opened: the one line the
  // person then needs.
  // Inside an agent's session: the plain page, never a sign-in link.
  // Sign-in: a link only where `web login` would print one.
  let link: string | null = webOpenRefusal(getStateDir()) ? origin : null;
  // Issue 819: its code registered with the server from this terminal, so
  // on first run (nobody signed in yet) it signs this browser in, on the
  // address too. The tab's own path rides along as `next`.
  let code: string | null = null;
  if (link === null) {
    code = new URL(freshLoginLink(options.port, "/", origin)).searchParams.get(
      "c",
    );
    if (code) await registerLoginLink(getStateDir(), options.port, code);
  }
  const signIn = (next?: string) =>
    (link ??= code
      ? loginLink(origin, code, next ?? "/")
      : freshLoginLink(options.port, next ?? "/", origin));
  const browser = openOrFocusDenWebUrl(
    signIn,
    options.port,
    options.action !== "open",
  );
  if (browser.status === "skipped") {
    // Its origin (never the link): which run tried to open what.
    console.log(
      chalk.gray(
        `  Browser open skipped (${browser.why}): ${origin.replace(/\/+$/, "")}\n`,
      ),
    );
    return;
  }
  if (browser.status === "focused") {
    console.log(chalk.green(`  OK Focused existing ${browser.app} tab`));
    console.log(chalk.gray(`  ${shownNow}\n`));
    return;
  }
  if (browser.status === "opened") {
    console.log(
      chalk.green(`  OK Opened ${product().cli} web in your browser`),
    );
    console.log(chalk.gray(`  ${shownNow}\n`));
    return;
  }

  if (browser.status === "error") {
    const appList = browser.apps.join(", ");
    console.log(
      chalk.yellow(
        `\n  Could not inspect browser tabs, so ${product().title} did not open a new tab.`,
      ),
    );
    console.log(
      chalk.gray(
        `  macOS may need Automation permission for your terminal to control ${appList}.`,
      ),
    );
    console.log(
      chalk.gray(`  Run: ${product().cli} web --setup-browser-access`),
    );
  } else {
    console.log(chalk.yellow("\n  Could not open a browser automatically."));
  }
  // Sign-in: a link is printed only to a terminal.
  if (terminalRefusal(onTerminal())) {
    console.log(chalk.gray(`  ${noLinkHereLine(origin, product().cli)}\n`));
    return;
  }
  console.log(
    `  Sign in (once, within ${ttlText(loginLinkTtl())}): ${signIn()}\n`,
  );
}

// ── SEC-1b: sign-in (`web login`, `web sessions`, `web logout`) ─────────────

/**
 * A fresh one-time sign-in link for `origin` (D80: the install's address,
 * web.url, by default; an Error saying it isn't set when it isn't).
 */
export function freshLoginLink(
  port: number,
  next = "/",
  origin?: string,
  stateDir: string = getStateDir(),
  person: PersonCheck = {},
): string {
  void port; // the link is on the address, whatever port serves it
  const refused = personHereRefusal({ ...person, stateDir });
  if (refused) throw new Error(refused);
  return loginLink(
    origin ?? requireWebUrl(product().cli),
    mintLoginCode(ensureWebSecret(stateDir), Date.now(), loginLinkTtl()),
    next,
  );
}

/**
 * `<cli> web claim-link [--json] [--port <port>]` (0.4.15): a one-time
 * setup link, `http://localhost:<port>/?claim=<code>` (30 minutes), on
 * stdout alone. Opening it signs that browser in, so it can approve an
 * agent's changes from the first page. Refused inside an agent's session:
 * the person opens it, never an agent. Never logged.
 */
export function cmdWebClaimLink(args: string[], io: CliIo = stdIo): number {
  const usage = `Usage: ${product().cli} web claim-link [--json] [--port <port>]\n`;
  if (isHelp(args)) {
    io.out(
      usage +
        "  Prints a one-time setup link (it lasts 30 minutes and works once). Open it\n" +
        "  yourself, in the browser on this machine: it signs that browser in, so you\n" +
        "  can approve what an agent asks to change. Don't let any agent open it.\n",
    );
    return 0;
  }
  const refused = printRefusal(io);
  if (refused) {
    io.err(`${product().cli}: ${refused}\n`);
    return 1;
  }
  let port: number;
  let rest: string[];
  try {
    ({ port, rest } = takePort(args));
  } catch (e) {
    io.err(`${(e as Error).message}\n`);
    return 2;
  }
  const asJson = rest.includes("--json");
  if (rest.some((a) => a !== "--json")) {
    io.err(usage);
    return 2;
  }
  const now = Date.now();
  // D80: on the install's address, the one the person's browsers use.
  // Issue 666's one exception: while it is unset (a fresh install whose
  // only edge name is a loopback one, never written as web.url), this
  // link alone is on this machine's own origin, since it is opened in the
  // browser on this machine. It writes nothing, and says the address isn't
  // set. A session made there is a localhost one only.
  const cli = product().cli;
  const w = (io.webUrl ?? readWebUrl)();
  const origin = w ? w.url : localhostOrigin(port);
  const unsetNote = w
    ? ""
    : `${cli}: ${notSetLine(cli)} (the name other devices open: your split-DNS name or edge alias; \`${cli} doctor\` offers it when it finds one). Until then this link works only in the browser on this machine.\n`;
  const url = claimLink(
    origin,
    mintClaimCode(ensureWebSecret(io.stateDir ?? getStateDir()), now),
  );
  if (asJson)
    io.out(
      `${JSON.stringify({ url, expiresAt: new Date(now + CLAIM_CODE_TTL_MS).toISOString(), ...(w ? {} : { address: unsetNote.slice(cli.length + 2).trim() }) })}\n`,
    );
  else {
    if (unsetNote) io.err(unsetNote);
    io.err(
      `${product().cli}: open this link yourself within 30 minutes; it signs in one browser, once. Don't let any agent open it.\n`,
    );
    io.out(`${url}\n`);
  }
  return 0;
}

interface CliIo {
  out: (s: string) => void;
  err: (s: string) => void;
  stateDir?: string;
  /** D80: the install's address (web.url); readWebUrl by default. */
  webUrl?: () => WebUrl | null;
  /** Issue 455: the address check's parts (tests swap the owner lookup). */
  addressDeps?: Partial<CheckDeps>;
  /** Sign-in: where this runs (tests give its parents and the terminal). */
  person?: PersonCheck;
}

/** Sign-in: personHereRefusal's parts, and whether output is a terminal. */
type PersonCheck = Omit<PersonHereDeps, "stateDir" | "env"> & {
  tty?: boolean;
};

/** Sign-in: `web up`'s line where it prints no link: the address, and what to run. */
export function noLinkHereLine(origin: string, cli: string): string {
  return `${origin.replace(/\/+$/, "")} (a sign-in link is printed only in a terminal: run \`${cli} web login\` in one)`;
}

/**
 * Sign-in: why `web up` / `web open` won't make a sign-in link here (it
 * opens the plain page instead), or null: the checks `web login` makes.
 */
export function webOpenRefusal(
  stateDir: string,
  person: PersonCheck = {},
): string | null {
  return (
    personHereRefusal({ ...person, stateDir }) ??
    terminalRefusal(person.tty ?? onTerminal())
  );
}

/** Whether this process's output is on a terminal (stdout and stderr). */
function onTerminal(): boolean {
  return !!process.stdout.isTTY && !!process.stderr.isTTY;
}

/** Sign-in: why this command won't let a browser in from here, or null. */
function grantRefusal(io: CliIo): string | null {
  return personHereRefusal({
    ...io.person,
    stateDir: io.stateDir ?? getStateDir(),
  });
}

/** grantRefusal, then: a link or code is printed only to a terminal. */
function printRefusal(io: CliIo): string | null {
  return grantRefusal(io) ?? terminalRefusal(io.person?.tty ?? onTerminal());
}

/**
 * Issue 455: the origin a link may carry. The install's address (web.url)
 * when it was just proven to reach this Den; else Den's own port here
 * when that was, with the one sentence that says why (once per change).
 * When nothing answers as this Den (its server isn't running), `wanted`
 * as before: nothing was proven either way.
 */
export async function provenOrigin(
  port: number,
  wanted: string,
  stateDir: string,
  say: (line: string) => void,
  deps: Partial<CheckDeps> = {},
): Promise<{ origin: string; state: AddressState }> {
  const state = await checkAddress({
    webPort: port,
    wanted,
    key: localIdentityKey(stateDir),
    cli: product().cli,
    ...deps,
  });
  const given = givenAddress(state) ?? wanted;
  // Nothing answers it: still given (D80), said plainly next to it.
  for (const l of upAddressLines(
    state,
    { lang: cliLanguage(), title: product().title, cli: product().cli },
    (deps.edgeDown ?? (() => edgeDownFor(wanted)))(),
  ))
    say(l);
  if (given !== wanted && noticeOnce(stateDir, state)) {
    const line = noticeLine(state, {
      lang: cliLanguage(),
      title: product().title,
      cli: product().cli,
    });
    if (line) say(line);
  }
  return { origin: given, state };
}
/** Whether `url` is the edge address here (issue 455: isEdgeAddress). */
function isEdgeAddressHere(url: string): boolean {
  let domains: string[] = [];
  try {
    domains = edgeDomains(readEdgeConfig());
  } catch {
    domains = []; // no edge configured: only a loopback name counts
  }
  return isEdgeAddress(url, domains);
}

/**
 * Whether the edge that serves `wanted` is down, when Den can tell: the
 * install has an edge publishing the address's port, and its container
 * isn't running. null when Den can't tell (no edge config, another port).
 */
export function edgeDownFor(wanted: string): boolean | null {
  let cfg: ReturnType<typeof readEdgeConfig>;
  try {
    cfg = readEdgeConfig();
  } catch {
    return null;
  }
  if (!cfg.ports) return null;
  let port: number;
  try {
    const u = new URL(wanted);
    port = Number(u.port) || (u.protocol === "https:" ? 443 : 80);
  } catch {
    return null;
  }
  if (port !== cfg.ports.http && port !== cfg.ports.https) return null;
  try {
    return containerState(edgeNames(cfg.org).container) !== "running";
  } catch {
    return null;
  }
}

const stdIo: CliIo = {
  out: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s),
};

/** `--help` or `-h` among a subcommand's args. */
function isHelp(args: readonly string[]): boolean {
  return args.includes("--help") || args.includes("-h");
}

/** `--port <p>` / `--port=<p>` / `-p <p>`, and the rest of `args`. */
function takePort(args: string[]): { port: number; rest: string[] } {
  let port = parsePort(process.env.PORT);
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--port" || a === "-p") {
      port = parsePort(args[++i]);
    } else if (a.startsWith("--port=")) {
      port = parsePort(a.slice("--port=".length));
    } else rest.push(a);
  }
  return { port, rest };
}

const LOGIN_USAGE = () =>
  `Usage: ${product().cli} web login [--next <path>] [--host <name> | --origin <url>] [--no-wait] [--port <port>]\n`;

/** `web login`'s arguments, or an exit code (usage or a bad value, already said). */
function parseLoginArgs(
  args: string[],
  io: CliIo,
):
  | { port: number; next: string; origin: string | null; noWait: boolean }
  | number {
  let next = "/";
  let origin: string | null = null;
  let noWait = false;
  let port: number;
  let rest: string[];
  try {
    ({ port, rest } = takePort(args));
  } catch (e) {
    io.err(`${(e as Error).message}\n`);
    return 2;
  }
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    const val = (flag: string) =>
      a === flag
        ? rest[++i]
        : a.startsWith(`${flag}=`)
          ? a.slice(flag.length + 1)
          : undefined;
    if (a === "--no-wait") {
      noWait = true;
      continue;
    }
    const n = val("--next");
    const o = val("--origin");
    const h = val("--host");
    if (n !== undefined) next = n;
    else if (h !== undefined) {
      const found = edgeOriginFor(h, port);
      if (typeof found !== "string") {
        io.err(found.error);
        return 2;
      }
      origin = found;
    } else if (o !== undefined) {
      origin = parseOrigin(o);
      if (!origin) {
        io.err(
          `--origin must be http(s)://host[:port] with no path, got "${o}"\n`,
        );
        return 2;
      }
    } else {
      io.err(LOGIN_USAGE());
      return 2;
    }
  }
  return { port, next, origin, noWait };
}

const LOGIN_HELP = () =>
  LOGIN_USAGE() +
  "  Prints a one-time sign-in link (open it within web.login_link_ttl, 5 minutes\n" +
  "  unless set) for one browser, then waits until it is used. Before anyone has\n" +
  "  signed in here, the link signs that browser in. After that it shows a code,\n" +
  "  and a browser that is already signed in approves it (Settings › Access).\n" +
  '  "Signed in: <browser> (<address>) at <time>", or "Expired: nobody used the\n' +
  '  link" (exit 1). On this machine `web up` opens such a link by itself.\n' +
  "  From another machine, pass the edge hostname as --host, or a LAN address\n" +
  "  as --origin.\n" +
  "  --next <path>   where the browser lands after signing in (same origin only)\n" +
  "  --host <name>   an edge hostname that routes here (an edge domain or alias,\n" +
  "                  a VPN name among them): the link uses its edge URL\n" +
  "  --origin <url>  the address the browser uses, http(s)://host[:port]\n" +
  "  --no-wait       print the link and exit (for scripts); it shows a code for\n" +
  "                  a signed-in browser to approve\n";

/**
 * `<cli> web login --no-wait`: a fresh sign-in link on stdout, alone (the
 * only place a login code is ever printed); a note on stderr. `--host` for
 * an edge hostname (its URL from the edge config), `--origin` for any
 * allowed origin (a LAN name), where the cookie must be set (the
 * signed-out page there says which). The link signs in when opened.
 */
export async function cmdWebLogin(
  args: string[],
  io: CliIo = stdIo,
): Promise<number> {
  if (isHelp(args)) {
    io.out(LOGIN_HELP());
    return 0;
  }
  const refused = printRefusal(io);
  if (refused) {
    io.err(`${product().cli}: ${refused}\n`);
    return 1;
  }
  const a = parseLoginArgs(args, io);
  if (typeof a === "number") return a;
  let origin: string;
  try {
    origin =
      a.origin ?? requireWebUrl(product().cli, (io.webUrl ?? readWebUrl)());
  } catch (e) {
    io.err(`${product().cli}: ${(e as Error).message}\n`);
    return 1;
  }
  const stateDir = io.stateDir ?? getStateDir();
  // Issue 455: an origin the person named (--origin, --host) is theirs;
  // the install's address is checked first.
  if (!a.origin)
    ({ origin } = await provenOrigin(
      a.port,
      origin,
      stateDir,
      (l) => io.err(`${product().cli}: ${l}\n`),
      io.addressDeps,
    ));
  const link = freshLoginLink(a.port, a.next, origin, stateDir, io.person);
  io.err(
    `${product().cli}: open this link within ${ttlText(loginLinkTtl())}, in one browser, once. ${APPROVE_IN_BROWSER}\n`,
  );
  io.out(`${link}\n`);
  return 0;
}

/** D16: web.login_link_ttl, read now (LOGIN_CODE_TTL_MS when unreadable). */
export function loginLinkTtl(): number {
  try {
    return readWebAuthConfig(getDistRoot(), product().configFile)
      .loginLinkTtlMs;
  } catch {
    return LOGIN_CODE_TTL_MS;
  }
}

/** "5 minutes", "90 seconds", "1 minute". */
export function ttlText(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s % 60 !== 0) return `${s} seconds`;
  const m = s / 60;
  return m === 1 ? "1 minute" : `${m} minutes`;
}

/** D16: the countdown's text, "4:59 left". */
export function countdownLeft(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")} left`;
}

/** "10:42" in this machine's time. */
function clockTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/**
 * Issue 819: register a sign-in link's code with the running server (the
 * CLI's bearer, from this terminal), as `web login` does: on first run it
 * then signs in wherever it is opened. Whether it was registered; nothing
 * is printed.
 */
async function registerLoginLink(
  stateDir: string,
  port: number,
  code: string,
): Promise<boolean> {
  const secret = ensureWebSecret(stateDir);
  const checked = checkLoginCode(code, secret);
  if (!checked.ok) return false;
  const reg = await serverCall(stateDir, port, "POST", "/api/web/logins", {
    nonce: checked.nonce,
    expiresAt: checked.expiresAt,
  });
  return reg?.status === 200;
}

/** Issue 819: what a link opened after the first sign-in asks for. */
const APPROVE_IN_BROWSER =
  "Once someone has signed in here, it shows a code: approve it in a browser that is signed in (Settings › Access).";

/**
 * `<cli> web login` (SEC-2a; issue 819): the link, then a wait until it is
 * used, approved or denied, or expires. The CLI registers the link's nonce
 * with the running server (its bearer, from this terminal) and polls that
 * wait. On first run (nobody has signed in here yet) the registered link
 * signs its browser in; after that, it opens the pairing screen and a
 * signed-in browser approves it. With no server running (or `--no-wait`)
 * it prints the link alone, unregistered.
 */
export async function cmdWebLoginWait(
  args: string[],
  io: CliIo = stdIo,
  opts: { pollMs?: number; maxWaitMs?: number; countdown?: boolean } = {},
): Promise<number> {
  if (isHelp(args)) {
    io.out(LOGIN_HELP());
    return 0;
  }
  const refused = printRefusal(io);
  if (refused) {
    io.err(`${product().cli}: ${refused}\n`);
    return 1;
  }
  const a = parseLoginArgs(args, io);
  if (typeof a === "number") return a;
  if (a.noWait)
    return cmdWebLogin(
      args.filter((x) => x !== "--no-wait"),
      io,
    );
  // D80: the link is on the install's address (or --host/--origin's).
  let origin: string;
  try {
    origin =
      a.origin ?? requireWebUrl(product().cli, (io.webUrl ?? readWebUrl)());
  } catch (e) {
    io.err(`${product().cli}: ${(e as Error).message}\n`);
    return 1;
  }
  const stateDir = io.stateDir ?? getStateDir();
  // Issue 455: the install's address only when it reaches this Den.
  if (!a.origin)
    ({ origin } = await provenOrigin(
      a.port,
      origin,
      stateDir,
      (l) => io.err(`${product().cli}: ${l}\n`),
      io.addressDeps,
    ));
  const secret = ensureWebSecret(stateDir);
  const now = Date.now();
  const ttl = loginLinkTtl();
  const loginCode = mintLoginCode(secret, now, ttl);
  const checked = checkLoginCode(loginCode, secret, now);
  if (!checked.ok) {
    io.err(`${product().cli}: could not make a sign-in link\n`);
    return 1;
  }
  // Issue 819: on first run, a link opened away from this computer asks
  // for this code (printed below only then).
  const confirm = newConfirmCode();
  const reg = await serverCall(stateDir, a.port, "POST", "/api/web/logins", {
    nonce: checked.nonce,
    code: confirm,
    expiresAt: checked.expiresAt,
  });
  const link = loginLink(origin, loginCode, a.next);
  if (!reg) {
    io.err(
      `${product().cli}: no ${product().title} web server answers on port ${a.port}, so this ` +
        "doesn't wait (as --no-wait). Start it " +
        `(\`${product().cli} web up\`), then open this link within ${ttlText(ttl)}. ${APPROVE_IN_BROWSER}\n`,
    );
    io.out(`${link}\n`);
    return 0;
  }
  const regJson = (reg.json ?? {}) as { id?: unknown; firstRun?: unknown };
  const id = regJson.id;
  if (reg.status !== 200 || typeof id !== "string") {
    io.err(`${product().cli}: ${apiError(reg)}\n`);
    return 1;
  }
  io.err(
    regJson.firstRun === true
      ? `${product().cli}: open this link within ${ttlText(ttl)}, in the browser to sign in. ` +
          `Opened on another computer, it asks for this code: ${confirm}\n`
      : `${product().cli}: open this link within ${ttlText(ttl)}, in the browser to sign in. ${APPROVE_IN_BROWSER}\n`,
  );
  io.out(`${link}\n`);
  // D16: on a terminal, the time left, in place.
  const tty = opts.countdown ?? (io === stdIo && !!process.stderr.isTTY);
  const waiting = `${product().cli}: waiting for the link to be used…`;
  const tick = () =>
    io.err(`\r${waiting} ${countdownLeft(checked.expiresAt - Date.now())} `);
  if (tty) tick();
  else io.err(`${waiting}\n`);
  const pollMs = opts.pollMs ?? 1000;
  // The link's own time, then the 10 minutes an opened link's device has
  // to be approved (pair-requests.ts).
  const deadline = Date.now() + (opts.maxWaitMs ?? ttl + 11 * 60_000);
  let toldPairing = false;
  for (;;) {
    await new Promise((r) => setTimeout(r, pollMs));
    if (tty) tick();
    const r = await serverCall(
      stateDir,
      a.port,
      "GET",
      `/api/web/logins/${id}`,
    );
    const j = (r?.json ?? {}) as {
      state?: string;
      device?: string;
      client?: string;
      usedAt?: string;
    };
    // The countdown's line ends before the outcome's.
    const over =
      !r ||
      j.state === "used" ||
      j.state === "denied" ||
      j.state === "refused" ||
      j.state === "expired" ||
      r.status === 404 ||
      Date.now() > deadline;
    if (tty && over) io.err("\n");
    // Issue 819: opened once the install is set up: its device waits for
    // a signed-in browser's approval.
    if (r && j.state === "pairing" && !toldPairing) {
      toldPairing = true;
      if (tty) io.err("\n");
      io.err(
        `${product().cli}: opened in ${j.device ?? "a browser"}${j.client ? ` (${j.client})` : ""}. ` +
          // Issue 819: the pairing code stays on that device's screen.
          "Read the code on that device's screen, and type it in a browser that is signed in, at Settings › Access.\n",
      );
    }
    if (r && j.state === "used") {
      io.out(
        `Signed in: ${j.device ?? "a browser"}${j.client ? ` (${j.client})` : ""}` +
          ` at ${clockTime(j.usedAt ?? new Date().toISOString())}\n`,
      );
      return 0;
    }
    if (r && j.state === "denied") {
      io.err("Denied in a signed-in browser; the link no longer works\n");
      return 1;
    }
    // A server from before issue 819 (its page asked for a code).
    if (r && j.state === "refused") {
      io.err("Refused: too many wrong codes; the link no longer works\n");
      return 1;
    }
    if (
      (r && (j.state === "expired" || r.status === 404)) ||
      Date.now() > deadline
    ) {
      io.err(
        toldPairing
          ? "Expired: nobody approved it\n"
          : "Expired: nobody used the link\n",
      );
      return 1;
    }
    if (!r) {
      io.err(
        `${product().cli}: the server stopped answering; the link can't be used now\n`,
      );
      return 1;
    }
  }
}

/**
 * `web login --host <name>`: the origin a browser uses for an edge hostname
 * that routes to this server (edge.routes under any edge domain or alias),
 * or why there is none and what to add.
 */
export function edgeOriginFor(
  name: string,
  port: number,
): string | { error: string } {
  const want = name.trim().toLowerCase().replace(/\.$/, "");
  let routes: { host: string; url: string }[] = [];
  try {
    routes = webRouteHosts(readEdgeConfig(), new Set([port, readWebPort()]));
  } catch {
    routes = [];
  }
  const hit = routes.find((r) => r.host === want);
  if (hit) return hit.url;
  const known = routes.map((r) => r.host);
  return {
    error:
      `--host ${name} is not a hostname this server answers to` +
      (known.length
        ? ` (its edge hostnames: ${known.join(", ")}).\n`
        : " (no edge route reaches this server).\n") +
      "  Add it to the config's edge block: its domain to edge.aliases (a VPN\n" +
      "  name), or a route to this server in edge.routes, then `edge up`. For a\n" +
      "  LAN name (DEN_BIND_HOST and web.allow_plain_http_remote) pass\n" +
      "  --origin http://<name>:<port> instead.\n",
  };
}

interface SessionRow {
  id: string;
  createdAt: string;
  lastSeenAt: string;
  userAgent: string;
  host: string;
}

/**
 * A call to the running server with the person token, or null when no
 * server answers on the port (the caller then edits the state files).
 */
function serverCall(
  stateDir: string,
  port: number,
  method: string,
  p: string,
  body?: unknown,
): Promise<{ status: number; json: unknown } | null> {
  return new Promise((resolve) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const to = webProbeTarget(process.env.DEN_BIND_HOST, port);
    const req = http.request(
      {
        host: to.host,
        port,
        path: p,
        method,
        timeout: 10_000,
        setHost: false,
        headers: {
          host: to.hostHeader,
          ...cliAuthHeaders(stateDir),
          ...(payload !== undefined
            ? {
                "Content-Type": "application/json",
                "Content-Length": String(Buffer.byteLength(payload)),
              }
            : {}),
        },
      },
      (res) => {
        let out = "";
        res.setEncoding("utf-8");
        res.on("data", (d: string) => (out += d));
        res.on("end", () => {
          let json: unknown = null;
          try {
            json = JSON.parse(out);
          } catch {
            /* not JSON */
          }
          resolve({ status: res.statusCode ?? 0, json });
        });
      },
    );
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(null));
    req.end(payload);
  });
}

function offlineStore(stateDir: string): WebSessionStore {
  return new WebSessionStore({
    stateDir: () => stateDir,
    secret: () => readWebSecret(stateDir),
  });
}

function apiError(r: { status: number; json: unknown }): string {
  const e = (r.json as { error?: unknown } | null)?.error;
  return typeof e === "string" ? e : `the server answered ${r.status}`;
}

/** `<cli> web sessions [--json]`: the signed-in browsers. */
export async function cmdWebSessions(
  args: string[],
  io: CliIo = stdIo,
): Promise<number> {
  let port: number;
  let rest: string[];
  try {
    ({ port, rest } = takePort(args));
  } catch (e) {
    io.err(`${(e as Error).message}\n`);
    return 2;
  }
  const usage = `Usage: ${product().cli} web sessions [--json] [--port <port>]\n`;
  if (isHelp(rest)) {
    io.out(
      usage +
        "  The browsers signed in to this server: ID (for `web logout <id>`), CREATED,\n" +
        `  LAST SEEN, HOST and USER AGENT. LAST SEEN is written at most once a\n` +
        `  minute (${SESSION_TOUCH_MS / 1000} s) per session, so it trails a browser's last request by up to\n` +
        "  that long (right after sign-in it equals CREATED). A session never\n" +
        "  expires: it ends at sign-out or `web logout`.\n",
    );
    return 0;
  }
  const asJson = rest.includes("--json");
  if (rest.some((a) => a !== "--json")) {
    io.err(usage);
    return 2;
  }
  const stateDir = io.stateDir ?? getStateDir();
  let rows: SessionRow[];
  const r = await serverCall(stateDir, port, "GET", "/api/web/sessions");
  if (r) {
    if (r.status !== 200) {
      io.err(`${product().cli}: ${apiError(r)}\n`);
      return 1;
    }
    rows = (r.json as { sessions: SessionRow[] }).sessions;
  } else {
    rows = offlineStore(stateDir)
      .list()
      .map((x) => ({
        id: sessionIdPrefix(x.key),
        createdAt: new Date(x.createdAt).toISOString(),
        lastSeenAt: new Date(x.lastSeenAt).toISOString(),
        userAgent: x.userAgent,
        host: x.host,
      }));
  }
  if (asJson) {
    io.out(`${JSON.stringify(rows, null, 2)}\n`);
    return 0;
  }
  if (rows.length === 0) {
    io.out("No signed-in browsers.\n");
    return 0;
  }
  // issue 206: a person reads these in this machine's zone (--json: ISO).
  const when = (iso: string) => localDateTime(iso);
  const table = [
    ["ID", "CREATED", "LAST SEEN", "HOST", "USER AGENT"],
    ...rows.map((x) => [
      x.id,
      when(x.createdAt),
      when(x.lastSeenAt),
      x.host,
      x.userAgent,
    ]),
  ];
  const widths = table[0].map((_, c) =>
    Math.max(...table.map((row) => row[c].length)),
  );
  for (const row of table)
    io.out(
      `${row
        .map((cell, c) =>
          c === row.length - 1 ? cell : cell.padEnd(widths[c]),
        )
        .join("  ")
        .trimEnd()}\n`,
    );
  return 0;
}

/**
 * `<cli> web logout [<id prefix>] [--all]`: sign out one browser, or every
 * browser; `--all` also rotates web.secret, which ends every session and
 * every person token (the CLI re-reads it, so it keeps working), and
 * revokes every agent's actor token (SEC-1 §6c.2).
 */
export async function cmdWebLogout(
  args: string[],
  io: CliIo = stdIo,
): Promise<number> {
  let port: number;
  let rest: string[];
  try {
    ({ port, rest } = takePort(args));
  } catch (e) {
    io.err(`${(e as Error).message}\n`);
    return 2;
  }
  const usage = `Usage: ${product().cli} web logout [<id prefix>] [--all] [--port <port>]\n`;
  if (isHelp(rest)) {
    io.out(
      usage +
        "  <id prefix>  sign out one browser (an ID from `web sessions`)\n" +
        "  (none)       sign out every browser; agents keep their tokens\n" +
        "  --all        sign out every browser, rotate web.secret (every person token\n" +
        "               is void; this CLI re-reads it) and revoke every agent's token:\n" +
        "               a running agent must be restarted or resumed for a new one\n",
    );
    return 0;
  }
  const all = rest.includes("--all");
  const ids = rest.filter((a) => a !== "--all");
  if (
    ids.length > 1 ||
    ids.some((a) => a.startsWith("-")) ||
    (all && ids.length)
  ) {
    io.err(usage);
    return 2;
  }
  const id = ids[0];
  const stateDir = io.stateDir ?? getStateDir();
  const r = await serverCall(stateDir, port, "POST", "/api/web/logout", {
    ...(id ? { id } : {}),
    ...(all ? { rotate: true } : {}),
  });
  let ended: number;
  let agentTokens = 0;
  if (r) {
    if (r.status !== 200) {
      io.err(`${product().cli}: ${apiError(r)}\n`);
      return 1;
    }
    const j = r.json as { ended?: unknown[]; agentTokens?: unknown };
    ended = (j.ended ?? []).length;
    if (typeof j.agentTokens === "number") agentTokens = j.agentTokens;
  } else {
    // No server: the state files themselves (the same OS user's).
    const store = offlineStore(stateDir);
    try {
      ended = id ? (store.endByPrefix(id), 1) : store.endAll();
    } catch (e) {
      io.err(`${product().cli}: ${(e as Error).message}\n`);
      return 1;
    }
    if (all) {
      if (readWebSecret(stateDir)) rotateWebSecret(stateDir);
      agentTokens = revokeAllActorTokens(stateDir);
    }
  }
  io.out(
    `Signed out ${ended} browser${ended === 1 ? "" : "s"}.` +
      (all
        ? ` web.secret rotated: every old session and person token is void; this CLI keeps working.` +
          ` Revoked ${agentTokens} agent token${agentTokens === 1 ? "" : "s"}: a running agent must be restarted or resumed to get a new one.`
        : "") +
      "\n",
  );
  return 0;
}

// ── SEC-2a: approve this computer with a code (`web approve`) ──────────────

/** Issue 819: `web approve <code>`'s answer. */
export const APPROVE_ONLY_IN_BROWSER =
  "A device is approved only from a browser that is signed in: open Settings › Access there and type the code that device's screen shows. `web approve --list` shows the ones waiting.";

interface WaitingRow {
  ref?: string;
  device: string;
  fromLink?: boolean;
  fromLogin?: string;
  client?: string;
  createdAt: string;
  expiresAt: string;
}

/** "3 min ago" for a list: whole minutes, or "just now". */
function agoText(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  return s < 60 ? "just now" : `${Math.round(s / 60)} min ago`;
}

/**
 * `<cli> web approve --list [--json]`: the computers whose signed-out page
 * shows a code, waiting. It asks the running server, with this CLI's
 * bearer: the requests live in its memory only. Issue 819: approving one
 * is a person's signed-in browser's (Settings › Access); `web approve
 * <code>` says so and changes nothing.
 */
export async function cmdWebApprove(
  args: string[],
  io: CliIo = stdIo,
): Promise<number> {
  let port: number;
  let rest: string[];
  try {
    ({ port, rest } = takePort(args));
  } catch (e) {
    io.err(`${(e as Error).message}
`);
    return 2;
  }
  const usage = `Usage: ${product().cli} web approve --list [--json] [--port <port>]\n`;
  if (isHelp(rest)) {
    io.out(
      usage +
        "  Lists the computers whose signed-out page shows a code, waiting to be let in.\n" +
        "  Approve one in a browser that is signed in: Settings › Access. A code lasts\n" +
        "  10 minutes and works once.\n" +
        "  --list   the computers waiting: browser, address, age, and whether a\n" +
        "           web login link asked (a code is typed off that computer's screen)\n" +
        "  --json   with --list: as JSON\n",
    );
    return 0;
  }
  const list = rest.includes("--list");
  const asJson = rest.includes("--json");
  const codes = rest.filter((a) => a !== "--list" && a !== "--json");
  if (
    codes.some((a) => a.startsWith("-")) ||
    (list ? codes.length !== 0 : codes.length !== 1 || asJson)
  ) {
    io.err(usage);
    return 2;
  }
  if (!list) {
    // Issue 819: only a person's signed-in browser approves a device.
    io.err(`${product().cli}: ${APPROVE_ONLY_IN_BROWSER}\n`);
    return 1;
  }
  const stateDir = io.stateDir ?? getStateDir();
  const r = await serverCall(stateDir, port, "GET", "/api/web/waiting");
  if (!r) {
    io.err(
      `${product().cli}: no ${product().title} web server answers on port ${port}. ` +
        "A waiting computer's code lives in the running server: start it " +
        `(\`${product().cli} web up\`) and reload the page on the other computer.\n`,
    );
    return 1;
  }
  if (r.status !== 200) {
    io.err(`${product().cli}: ${apiError(r)}\n`);
    return 1;
  }
  const rows = ((r.json as { waiting?: WaitingRow[] }).waiting ?? []).map(
    (w) => ({ ...w }),
  );
  if (asJson) {
    io.out(`${JSON.stringify(rows, null, 2)}\n`);
    return 0;
  }
  if (rows.length === 0) {
    io.out("No computers are waiting for approval.\n");
    return 0;
  }
  const table = [
    ["BROWSER", "ADDRESS", "WAITING", "FROM"],
    ...rows.map((w) => [
      w.device,
      w.client ?? "",
      agoText(w.createdAt),
      // Issue 819: no code here (it is read off that computer's screen).
      w.fromLogin
        ? `web login run at ${clockTime(w.fromLogin)}`
        : w.fromLink
          ? "a sign-in link"
          : "",
    ]),
  ];
  const widths = table[0].map((_, c) =>
    Math.max(...table.map((row) => row[c].length)),
  );
  for (const row of table)
    io.out(
      `${row
        .map((cell, c) =>
          c === row.length - 1 ? cell : cell.padEnd(widths[c]),
        )
        .join("  ")
        .trimEnd()}\n`,
    );
  return 0;
}

// ── SEC-2a: the owner (`web owner link`, `show`, `unlink`) ─────────────────

/**
 * `<cli> web owner [link|show|unlink] [--json]`: the GitHub account this
 * Den belongs to, which Sign in with GitHub admits.
 *  - link: GitHub's device flow, here in the terminal: the code and
 *    github.com/login/device, then a wait while you approve it. Den keeps
 *    `github:<id>` and the login (a 0600 file in the state dir) and drops
 *    the token at once. Refused while an owner is linked.
 *  - show (the default): who it is.
 *  - unlink: forget it. Signed-in browsers stay signed in.
 * `client` and `sleep` are a test's.
 */
export async function cmdWebOwner(
  args: string[],
  io: CliIo & {
    client?: GithubDeviceClient;
    sleep?: (ms: number) => Promise<void>;
    clientId?: string;
  } = stdIo,
): Promise<number> {
  const usage = `Usage: ${product().cli} web owner [link|show|unlink] [--json]\n`;
  if (isHelp(args)) {
    io.out(
      usage +
        "  link    link your GitHub account as this Den's owner (GitHub's device flow:\n" +
        `          enter the code it shows at ${GITHUB_DEVICE_PAGE}); only its id is kept\n` +
        "  show    who the owner is (the default)\n" +
        "  unlink  forget the owner; signed-in browsers stay signed in\n" +
        "  The owner can then sign in from any device: the signed-out page's\n" +
        "  Sign in with GitHub. No token is stored.\n",
    );
    return 0;
  }
  const asJson = args.includes("--json");
  const rest = args.filter((a) => a !== "--json");
  const sub = rest[0] ?? "show";
  if (rest.length > 1 || !["link", "show", "unlink"].includes(sub)) {
    io.err(usage);
    return 2;
  }
  const stateDir = io.stateDir ?? getStateDir();
  const cli = product().cli;
  const refused = sub === "show" ? null : grantRefusal(io);
  if (refused) {
    io.err(`${cli}: ${refused}\n`);
    return 1;
  }
  if (sub === "show") {
    const o = readWebOwner(stateDir);
    if (asJson) io.out(`${JSON.stringify({ owner: o }, null, 2)}\n`);
    else
      io.out(
        o
          ? `Owner: @${o.login} (${o.owner}), linked ${localDateTime(o.linkedAt)}.\n`
          : `No owner is linked. Run \`${cli} web owner link\`.\n`,
      );
    return 0;
  }
  if (sub === "unlink") {
    const was = clearWebOwner(stateDir);
    if (asJson) io.out(`${JSON.stringify({ unlinked: was }, null, 2)}\n`);
    else
      io.out(
        was
          ? `Unlinked @${was.login}. Signed-in browsers stay signed in (\`${cli} web logout\` ends them).\n`
          : "No owner was linked.\n",
      );
    return 0;
  }
  const linked = readWebOwner(stateDir);
  if (linked) {
    io.err(
      `${cli}: this Den's owner is @${linked.login} already; \`${cli} web owner unlink\` first.\n`,
    );
    return 1;
  }
  let clientId = io.clientId;
  if (clientId === undefined) {
    try {
      clientId = githubClientId(
        readWebAuthConfig(getDistRoot(), product().configFile).githubClientId,
      );
    } catch (e) {
      io.err(`${cli}: ${(e as Error).message}\n`);
      return 1;
    }
  }
  if (!clientId) {
    io.err(`${cli}: ${noClientIdMessage(cli)}\n`);
    return 1;
  }
  const ep = githubEndpoints();
  let outcome;
  try {
    outcome = await runDeviceFlow({
      clientId,
      client: io.client ?? githubDeviceClient(ep),
      ...(io.sleep ? { sleep: io.sleep } : {}),
      minIntervalMs: ep.fake || io.client ? 0 : 1000,
      onCode: (c) =>
        io.out(
          `Open ${GITHUB_DEVICE_PAGE} and enter this code:\n\n    ${c.userCode}\n\n` +
            `Waiting for you to approve it on GitHub (it asks for no permissions; ` +
            `the code lasts ${Math.round(c.expiresIn / 60)} min)…\n`,
        ),
    });
  } catch (e) {
    io.err(`${cli}: ${(e as Error).message}\n`);
    return 1;
  }
  if (outcome.kind !== "ok") {
    io.err(
      `${cli}: ${
        outcome.kind === "expired"
          ? "the code expired before it was approved; run it again"
          : outcome.kind === "denied"
            ? "the request was cancelled on GitHub"
            : outcome.message
      }\n`,
    );
    return 1;
  }
  const rec = writeWebOwner(outcome.identity, stateDir);
  if (outcome.expiringToken)
    io.err(`${product().cli}: warning: ${expiringTokenWarning()}\n`);
  if (asJson) io.out(`${JSON.stringify({ owner: rec }, null, 2)}\n`);
  else
    io.out(
      `Linked @${rec.login} (${githubPrincipal(outcome.identity.id)}) as this Den's owner; ` +
        "the token was not kept. Sign in with GitHub from your other devices now works.\n",
    );
  return 0;
}

// ── Issue 810: the fixture person (live checks on a test install) ──────────

/** What the fixture commands read: the CLI's io, and the test-install mark. */
type FixtureIo = CliIo & { testInstall?: () => boolean };

/** `web.test_install` from the distribution config (false when unreadable). */
function testInstallNow(io: FixtureIo): boolean {
  if (io.testInstall) return io.testInstall();
  try {
    return readWebAuthConfig(getDistRoot(), product().configFile).testInstall;
  } catch {
    return false;
  }
}

const FIXTURE_PERSON_HELP = () =>
  `Usage: ${product().cli} web fixture-person [${FROM_SETUP_SECRET_FLAG} [--port <port>]]\n` +
  "  Setting up the fixture person live checks sign in as is a button: on a test\n" +
  "  install, sign in and press Settings › Access › Set up test person in your\n" +
  "  browser.\n" +
  `  ${FROM_SETUP_SECRET_FLAG}: on a test install started with the\n` +
  `  launcher's one-time setup value (${setupSecretEnvName()}), sends this\n` +
  "  command's own copy of it, once, and the install makes the fixture person.\n";

const setupSecretEnvName = () =>
  envName(getProfile(), FIXTURE_SETUP_SECRET_ENV_KEY);

/**
 * Issue 1018: `web fixture-person --from-setup-secret`: sends the CLI's
 * own copy of the launcher's setup value (from its environment, never an
 * argument, which other processes can read) to the server, once. The
 * server checks everything; this never prints the value.
 */
async function fixturePersonFromSetupSecret(
  args: string[],
  io: FixtureIo,
): Promise<number> {
  let port: number | null = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const v =
      a === "--port" ? args[++i] : a.startsWith("--port=") ? a.slice(7) : null;
    const n = v === null ? NaN : Number(v);
    if (Number.isInteger(n) && n >= 1 && n <= 65535) port = n;
    else {
      io.err(FIXTURE_PERSON_HELP());
      return 2;
    }
  }
  const name = setupSecretEnvName();
  const value = process.env[name];
  delete process.env[name];
  if (!value) {
    io.err(
      `${product().cli}: ${FROM_SETUP_SECRET_FLAG} sends the setup value from this command's environment (${name}), and it isn't set. Nothing was sent.\n`,
    );
    return 2;
  }
  const base = denWebBase(port ?? configuredPort());
  let r: Response;
  try {
    r = await fetch(`${base}/api/web/fixture-person/setup-secret`, {
      method: "POST",
      headers: { "content-type": "application/json", ...cliAuthHeaders() },
      body: JSON.stringify({ secret: value }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    io.err(
      `${product().cli}: the test install's web app isn't running, so the setup value wasn't sent. Start it (\`${product().cli} web up\`).\n`,
    );
    return 1;
  }
  const b = (await r.json().catch(() => null)) as {
    ok?: boolean;
    error?: string;
  } | null;
  if (r.ok && b?.ok) {
    io.out(
      `The ${FIXTURE_LABEL} is set up. Sign in as it with \`${product().cli} web fixture-login\`.\n`,
    );
    return 0;
  }
  io.err(
    `${product().cli}: ${b?.error ?? `the setup value was refused (the web app answered ${r.status})`}\n`,
  );
  return 1;
}

/**
 * `<cli> web fixture-person` (issue 810): setup is Settings' Set up test
 * person, a person's browser session only. This says so and fails; it
 * never asks the server (which refuses every CLI bearer there).
 */
export function cmdWebFixturePerson(
  args: string[],
  io: FixtureIo = stdIo,
): Promise<number> {
  if (isHelp(args)) {
    io.out(FIXTURE_PERSON_HELP());
    return Promise.resolve(0);
  }
  if (args[0] === FROM_SETUP_SECRET_FLAG)
    return fixturePersonFromSetupSecret(args.slice(1), io);
  io.err(
    `${product().cli}: setting up the ${FIXTURE_LABEL} is a button, not a command: ` +
      "on a test install, sign in and press Settings › Access › Set up test person in your browser.\n",
  );
  return Promise.resolve(1);
}

const FIXTURE_LOGIN_HELP = () =>
  `Usage: ${product().cli} web fixture-login [--next <path>] [--origin <url>]\n` +
  "  On a test install with its fixture person set up, prints a one-time sign-in\n" +
  "  link as the fixture person (for live checks; an agent may run it). Refused\n" +
  "  on any install not marked a test install.\n";

/**
 * `<cli> web fixture-login` (issue 810): the gate runner's one-time link
 * as the fixture person, on stdout alone. An agent may run it: it never
 * signs in as the person. Refused off a test install, or with no fixture
 * person set up.
 */
export async function cmdWebFixtureLogin(
  args: string[],
  io: FixtureIo = stdIo,
): Promise<number> {
  if (isHelp(args)) {
    io.out(FIXTURE_LOGIN_HELP());
    return 0;
  }
  let next = "/";
  let origin: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const val = (flag: string) =>
      a === flag
        ? args[++i]
        : a.startsWith(`${flag}=`)
          ? a.slice(flag.length + 1)
          : undefined;
    const n = val("--next");
    const o = n === undefined ? val("--origin") : undefined;
    if (n !== undefined) next = n;
    else if (o !== undefined) {
      origin = parseOrigin(o);
      if (!origin) {
        io.err(
          `--origin must be http(s)://host[:port] with no path, got "${o}"\n`,
        );
        return 2;
      }
    } else {
      io.err(FIXTURE_LOGIN_HELP());
      return 2;
    }
  }
  const testInstall = testInstallNow(io);
  if (!origin && testInstall) {
    try {
      origin = requireWebUrl(product().cli, (io.webUrl ?? readWebUrl)());
    } catch (e) {
      io.err(`${product().cli}: ${(e as Error).message}\n`);
      return 1;
    }
  }
  const r = fixtureLoginLink(io.stateDir ?? getStateDir(), {
    testInstall,
    origin: origin ?? "",
    next,
    ttlMs: loginLinkTtl(),
    configFile: product().configFile,
    cli: product().cli,
  });
  if (!r.ok) {
    io.err(`${product().cli}: ${r.error}\n`);
    return 1;
  }
  io.out(`${r.url}\n`);
  return 0;
}
