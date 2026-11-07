import chalk from "chalk";
import { execFileSync, spawn, spawnSync } from "child_process";
import * as fs from "fs";
import * as http from "http";
import * as net from "net";
import * as path from "path";
import { pathToFileURL } from "url";
import { CLI_SPAWN_TIMEOUT_MS, DEFAULT_PORT } from "../../shared/constants.js";
import {
  readSecretsConfig,
  secretsProcessEnv,
  type SecretsConfig,
} from "../../shared/secrets/index.js";
import { getDistRoot, getEngineRoot, getStateDir } from "../../shared/paths.js";
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
import { webRouteHosts } from "../../shared/edge/render.js";
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
  samePath,
} from "./server-identity.js";

import { product } from "../../shared/product.js";
import { redactSecrets } from "../../shared/redact.js";
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
  | { status: "focused"; app: string }
  | { status: "not-found" }
  | { status: "unsupported" }
  | { status: "error"; apps: string[]; error: string };

type BrowserOpenResult =
  | BrowserFocusResult
  | { status: "opened" }
  | { status: "open-failed"; error: string };

// Generous enough for a cold tsx start (the server now runs from live TS source
// by default), so `den web` doesn't print a false "did not become ready" while
// the server is in fact coming up.
const WEB_START_TIMEOUT_MS = 45_000;
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
    openBrowser: true,
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
    `http://localhost:${port}`,
    `http://127.0.0.1:${port}`,
  ];
}

export function isDenWebTabUrl(rawUrl: string, port: number): boolean {
  try {
    const parsed = new URL(rawUrl);
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

/**
 * Where `web up`'s probes (readiness, the CLI's own calls) reach the
 * server, and the Host they send: the address DEN_BIND_HOST binds. Unset,
 * 0.0.0.0 or `::` answer on loopback, so 127.0.0.1; one specific address
 * (a LAN IP with web.allow_plain_http_remote, or ::1) answers only there.
 * The Host names that address (an IPv6 one bracketed): the Host allowlist
 * accepts it (a loopback name, or the bound LAN address).
 */
export function webProbeTarget(
  bind: string | undefined,
  port: number,
): { host: string; hostHeader: string } {
  const b = (bind ?? "")
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  const host = b === "" || b === "0.0.0.0" || b === "::" ? "127.0.0.1" : b;
  return {
    host,
    hostHeader: `${net.isIPv6(host) ? `[${host}]` : host}:${port}`,
  };
}

async function getHttpText(
  port: number,
  requestPath: string,
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
        timeout: 1_500,
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
async function isDenWebApiRunning(port: number): Promise<boolean> {
  const json = async (p: string): Promise<unknown> => {
    const response = await getHttpText(port, p);
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

async function isDenWebUiReady(port: number): Promise<boolean> {
  const response = await getHttpText(port, "/index.html");
  return (
    // 422: the "Config is invalid" page, the shell serving as it should.
    (response?.statusCode === 200 || response?.statusCode === 422) &&
    /<html[\s>]/i.test(response.body) &&
    hasDenUiMarker(response.body)
  );
}

export async function isDenWebRunning(port: number): Promise<boolean> {
  return (await isDenWebApiRunning(port)) && (await isDenWebUiReady(port));
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
  const deadline = Date.now() + WEB_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await isDenWebRunning(port)) return true;
    // A server that refused to start has exited: no point waiting it out.
    if (pid !== undefined && !pidAlive(pid)) return isDenWebRunning(port);
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
 * Spawn `den web restart` as a DETACHED child so a running server can
 * restart ITSELF (e.g. from the "stale server" UI): the child stops whatever is
 * listening on `port` — the current server — then starts a fresh daemon,
 * surviving the current process's death. Returns the short-lived driver pid.
 * Mirrors resolveServerEntrypoint's preference for live tsx source.
 */
export function spawnDetachedWebRestart(port: number): number | undefined {
  const root = getDistRoot();
  const engine = getEngineRoot();
  const tsxBin = engineBin(process.platform === "win32" ? "tsx.cmd" : "tsx");
  const srcCli = path.join(engine, "src/ui/cli/index.ts");
  const builtCli = path.join(engine, "dist/src/ui/cli/index.js");

  let cmd: string;
  let baseArgs: string[];
  if (process.env.DEN_USE_DIST === "1" && fs.existsSync(builtCli)) {
    cmd = process.execPath;
    baseArgs = [builtCli];
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
  const tmp = `${statePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf-8");
  fs.renameSync(tmp, statePath);
}

function removeWebServerState(): void {
  try {
    fs.unlinkSync(webServerStatePath());
  } catch {
    /* absent or already removed */
  }
}

function listListeningPids(port: number): number[] {
  const result = spawnSync("lsof", [`-tiTCP:${port}`, "-sTCP:LISTEN"], {
    encoding: "utf-8",
    timeout: CLI_SPAWN_TIMEOUT_MS,
  });
  if (result.status !== 0) return [];
  return Array.from(
    new Set(
      result.stdout
        .split(/\r?\n/)
        .map((line) => Number(line.trim()))
        .filter((pid) => Number.isInteger(pid) && pid > 0),
    ),
  );
}

function commandForPid(pid: number): string {
  const result = spawnSync("ps", ["-p", String(pid), "-o", "command="], {
    encoding: "utf-8",
    timeout: CLI_SPAWN_TIMEOUT_MS,
  });
  return result.status === 0 ? result.stdout.trim() : "";
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
    if (listListeningPids(port).length === 0) return true;
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
  return denWebUrlAliases(port)
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
          return "focused"
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
          return "focused"
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
  return execFileSync("osascript", [], {
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

    if (result === "focused") return { status: "focused", app: app.name };
    if (result === "not-found") inspectedBrowser = true;
  }

  if (!inspectedBrowser && failedApps.length > 0) {
    return { status: "error", apps: failedApps, error: firstError };
  }

  return { status: "not-found" };
}

function openUrl(url: string): BrowserOpenResult {
  const cmd =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "cmd"
        : "xdg-open";
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
 * open`) always opens.
 */
function openOrFocusDenWebUrl(
  url: () => string,
  port: number,
  focus = true,
): BrowserOpenResult {
  if (focus) {
    const focusResult = focusExistingBrowserTab(port);
    if (focusResult.status === "focused") return focusResult;

    if (focusResult.status === "error" && process.platform === "darwin") {
      return focusResult;
    }
  }

  return openUrl(url());
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
  console.log(
    `  ${product().cli} web approve <code> | --list [--json] [--port <port>]`,
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
    "  login              Print a one-time sign-in link (60 s) and its code, then wait until it's used",
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
    "  approve <code>     Let in a computer whose signed-out page shows this code",
  );
  console.log("  (start/stop remain accepted as legacy aliases for up/down)");
  console.log();
  console.log(chalk.bold("Options:"));
  console.log("  --port, -p <port>  Use a non-default web port");
  console.log(
    "  --no-open          Start or check the server without opening a browser",
    "  --json             (up, restart) log on stderr; stdout: { ok, url, port, version? }",
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
export function cmdWebToken(
  args: string[],
  io: {
    out: (s: string) => void;
    err: (s: string) => void;
    stateDir?: string;
  } = {
    out: (s) => process.stdout.write(s),
    err: (s) => process.stderr.write(s),
  },
): number {
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
  const secret = ensureWebSecret(io.stateDir ?? getStateDir());
  io.err(
    `${product().cli}: this token grants your access (person:${osUser()}) to ` +
      `${product().title} web; keep it out of logs and shared shells.\n`,
  );
  io.out(`${personToken(secret)}\n`);
  return 0;
}

export async function cmdWeb(args: string[]): Promise<void> {
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
  if (args.includes("--help") || args.includes("-h")) {
    displayWebHelp();
    return;
  }

  const options = parseWebCommandArgs(args);
  if (options.setupBrowserAccess) {
    setupBrowserAccess();
    return;
  }

  const url = webUpUrl(options.port);

  // Never act on another distribution's server: not "already running", and
  // never a signal to it (down, restart).
  const identity = await refuseForeignServer(options.port, ownServer());
  const vouched = identity.kind === "ours" ? identity.pid : undefined;

  if (options.action === "down") {
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
      chalk.green(`\n  OK ${product().title} web is not running at ${url}\n`),
    );
    return;
  }

  if (options.action === "restart") {
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

  const apiRunning = await isDenWebApiRunning(options.port);
  let running = apiRunning && (await isDenWebUiReady(options.port));
  let started: StartedServer | null = null;

  if (apiRunning && !running) {
    console.log(
      chalk.yellow(
        `\n  Existing ${product().title} web server on ${url} is responding, but the UI assets are not available.`,
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
    console.log(chalk.cyan(`\n  Starting ${product().cli} web on ${url}...`));
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
  } else {
    recordRunningDenWebServer(options.port);
    console.log(
      chalk.green(`\n  OK ${product().title} web is already running at ${url}`),
    );
  }

  if (!options.openBrowser) {
    console.log(chalk.gray(`  Browser open skipped. Visit: ${url}\n`));
    return;
  }

  // SEC-1b: what opens is a sign-in link (localhost, one-time, 60 s). It
  // is printed only when the browser couldn't be opened: the one line the
  // person then needs.
  let link: string | null = null;
  const signIn = () => (link ??= freshLoginLink(options.port));
  const browser = openOrFocusDenWebUrl(
    signIn,
    options.port,
    options.action !== "open",
  );
  if (browser.status === "focused") {
    console.log(chalk.green(`  OK Focused existing ${browser.app} tab`));
    console.log(chalk.gray(`  ${url}\n`));
    return;
  }
  if (browser.status === "opened") {
    console.log(
      chalk.green(`  OK Opened ${product().cli} web in your browser`),
    );
    console.log(chalk.gray(`  ${url}\n`));
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
  console.log(`  Sign in (once, within 60 s): ${signIn()}\n`);
}

// ── SEC-1b: sign-in (`web login`, `web sessions`, `web logout`) ─────────────

/** A fresh one-time sign-in link for `origin` (localhost by default). */
export function freshLoginLink(
  port: number,
  next = "/",
  origin: string = localhostOrigin(port),
  stateDir: string = getStateDir(),
): string {
  return loginLink(origin, mintLoginCode(ensureWebSecret(stateDir)), next);
}

interface CliIo {
  out: (s: string) => void;
  err: (s: string) => void;
  stateDir?: string;
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
  "  Prints a one-time sign-in link (open it within 60 s) for one browser, and a\n" +
  "  code the page behind the link asks for, then waits until the link is used:\n" +
  '  "Signed in: <browser> (<address>) at <time>", or "Expired: nobody used the\n' +
  '  link" (exit 1). On localhost nothing asks for a sign-in; it is needed when\n' +
  "  this server is reached from another machine (pass the edge hostname as\n" +
  "  --host, or a LAN address as --origin).\n" +
  "  --next <path>   where the browser lands after signing in (same origin only)\n" +
  "  --host <name>   an edge hostname that routes here (an edge domain or alias,\n" +
  "                  a VPN name among them): the link uses its edge URL\n" +
  "  --origin <url>  the address the browser uses, http(s)://host[:port]\n" +
  "  --no-wait       print the link and exit; the link signs in by itself, no\n" +
  "                  code (for scripts)\n";

/**
 * `<cli> web login --no-wait`: a fresh sign-in link on stdout, alone (the
 * only place a login code is ever printed); a note on stderr. `--host` for
 * an edge hostname (its URL from the edge config), `--origin` for any
 * allowed origin (a LAN name), where the cookie must be set (the
 * signed-out page there says which). The link signs in when opened.
 */
export function cmdWebLogin(args: string[], io: CliIo = stdIo): number {
  if (isHelp(args)) {
    io.out(LOGIN_HELP());
    return 0;
  }
  const a = parseLoginArgs(args, io);
  if (typeof a === "number") return a;
  const link = freshLoginLink(
    a.port,
    a.next,
    a.origin ?? localhostOrigin(a.port),
    io.stateDir ?? getStateDir(),
  );
  io.err(
    `${product().cli}: open this link within 60 seconds; it signs in one browser, once.\n`,
  );
  io.out(`${link}\n`);
  return 0;
}

/** "10:42" in this machine's time. */
function clockTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/**
 * `<cli> web login` (SEC-2a): the link and an 8-character code, then a
 * wait until the link is used or expires. The page behind the link asks
 * for the code before it signs anything in. The CLI registers the link's
 * nonce and the code with the running server (its bearer) and polls that
 * wait; the code is shown here only, never logged. With no server running
 * (or `--no-wait`) it prints the link alone, as before.
 */
export async function cmdWebLoginWait(
  args: string[],
  io: CliIo = stdIo,
  opts: { pollMs?: number; maxWaitMs?: number } = {},
): Promise<number> {
  if (isHelp(args)) {
    io.out(LOGIN_HELP());
    return 0;
  }
  const a = parseLoginArgs(args, io);
  if (typeof a === "number") return a;
  if (a.noWait)
    return cmdWebLogin(
      args.filter((x) => x !== "--no-wait"),
      io,
    );
  const stateDir = io.stateDir ?? getStateDir();
  const secret = ensureWebSecret(stateDir);
  const now = Date.now();
  const loginCode = mintLoginCode(secret, now);
  const checked = checkLoginCode(loginCode, secret, now);
  if (!checked.ok) {
    io.err(`${product().cli}: could not make a sign-in link\n`);
    return 1;
  }
  const confirm = newConfirmCode();
  const reg = await serverCall(stateDir, a.port, "POST", "/api/web/logins", {
    nonce: checked.nonce,
    code: confirm,
    expiresAt: checked.expiresAt,
  });
  const link = loginLink(
    a.origin ?? localhostOrigin(a.port),
    loginCode,
    a.next,
  );
  if (!reg) {
    io.err(
      `${product().cli}: no ${product().title} web server answers on port ${a.port}, so this ` +
        "doesn't wait and the link asks for no code (as --no-wait). Start the server " +
        `(\`${product().cli} web up\`), then open this link within 60 seconds; it signs in one browser, once.\n`,
    );
    io.out(`${link}\n`);
    return 0;
  }
  const id = (reg.json as { id?: unknown } | null)?.id;
  if (reg.status !== 200 || typeof id !== "string") {
    io.err(`${product().cli}: ${apiError(reg)}\n`);
    return 1;
  }
  io.err(
    `${product().cli}: open this link within 60 seconds, in the browser to sign in. ` +
      `It asks for this code: ${confirm}\n`,
  );
  io.out(`${link}\n`);
  io.err(`${product().cli}: waiting for the link to be used…\n`);
  const pollMs = opts.pollMs ?? 1000;
  const deadline = Date.now() + (opts.maxWaitMs ?? 7 * 60_000);
  for (;;) {
    await new Promise((r) => setTimeout(r, pollMs));
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
    if (r && j.state === "used") {
      io.out(
        `Signed in: ${j.device ?? "a browser"}${j.client ? ` (${j.client})` : ""}` +
          ` at ${clockTime(j.usedAt ?? new Date().toISOString())}\n`,
      );
      return 0;
    }
    if (r && j.state === "refused") {
      io.err("Refused: too many wrong codes; the link no longer works\n");
      return 1;
    }
    if (
      (r && (j.state === "expired" || r.status === 404)) ||
      Date.now() > deadline
    ) {
      io.err("Expired: nobody used the link\n");
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
  const when = (iso: string) => iso.replace("T", " ").replace(/\.\d+Z$/, "Z");
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

interface WaitingRow {
  code: string;
  device: string;
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
 * `<cli> web approve <code> | --list [--json]`: let in a computer whose
 * signed-out page shows `<code>` (case and dashes don't matter), or list
 * the ones waiting. It asks the running server, with this CLI's bearer:
 * the requests live in its memory only, so with no server there is
 * nothing to approve.
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
  const usage = `Usage: ${product().cli} web approve <code> | --list [--json] [--port <port>]\n`;
  if (isHelp(rest)) {
    io.out(
      usage +
        "  Lets in the computer whose signed-out page shows <code> (like K7Q-42M; case\n" +
        "  and dashes don't matter). That page then signs in by itself. A code lasts\n" +
        "  10 minutes and works once.\n" +
        "  --list   the computers waiting: code, browser, address, age\n" +
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
  const stateDir = io.stateDir ?? getStateDir();
  const r = list
    ? await serverCall(stateDir, port, "GET", "/api/web/waiting")
    : await serverCall(stateDir, port, "POST", "/api/web/approve", {
        code: codes[0],
      });
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
  if (list) {
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
      ["CODE", "BROWSER", "ADDRESS", "WAITING"],
      ...rows.map((w) => [
        w.code,
        w.device,
        w.client ?? "",
        agoText(w.createdAt),
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
  const w = r.json as WaitingRow;
  io.out(
    `Approved: ${w.device}${w.client ? ` (${w.client})` : ""}. ` +
      "Its page signs in by itself.\n",
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
  if (sub === "show") {
    const o = readWebOwner(stateDir);
    if (asJson) io.out(`${JSON.stringify({ owner: o }, null, 2)}\n`);
    else
      io.out(
        o
          ? `Owner: @${o.login} (${o.owner}), linked ${o.linkedAt.replace("T", " ").replace(/\.\d+Z$/, "Z")}.\n`
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
