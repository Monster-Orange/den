import chalk from "chalk";
import { execFileSync, spawn, spawnSync } from "child_process";
import * as fs from "fs";
import * as http from "http";
import * as path from "path";
import {
  CLI_SPAWN_TIMEOUT_MS,
  DEFAULT_PORT,
  OP_ACCOUNT_DEFAULT,
} from "../../shared/constants.js";
import { getDistRoot, getEngineRoot, getStateDir } from "../../shared/paths.js";
import { hasDenUiMarker } from "../../shared/ui-marker.js";
import { engineBin } from "../../shared/engine.js";
import { readWebPort } from "../../shared/edge/config.js";

import { product } from "../../shared/product.js";
interface WebCommandOptions {
  action: "up" | "down" | "restart";
  port: number;
  openBrowser: boolean;
  silent: boolean;
  setupBrowserAccess: boolean;
}

interface StartedServer {
  pid: number | undefined;
  logPath: string;
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

    const req = http.get(
      {
        host: "127.0.0.1",
        port,
        path: requestPath,
        timeout: 1_500,
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

async function isDenWebApiRunning(port: number): Promise<boolean> {
  const response = await getHttpText(port, "/api/health");
  if (!response || response.statusCode !== 200) return false;
  try {
    return Array.isArray(JSON.parse(response.body));
  } catch {
    return false;
  }
}

async function isDenWebUiReady(port: number): Promise<boolean> {
  const response = await getHttpText(port, "/index.html");
  return (
    response?.statusCode === 200 &&
    /<html[\s>]/i.test(response.body) &&
    hasDenUiMarker(response.body)
  );
}

async function isDenWebRunning(port: number): Promise<boolean> {
  return (await isDenWebApiRunning(port)) && (await isDenWebUiReady(port));
}

async function waitForDenWeb(port: number): Promise<boolean> {
  const deadline = Date.now() + WEB_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await isDenWebRunning(port)) return true;
    await new Promise((resolve) => setTimeout(resolve, WEB_START_POLL_MS));
  }
  return false;
}

/** How to run the web server: Den's own files, from the engine root. */
function resolveServerEntrypoint(engine: string = getEngineRoot()): {
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
  const tsxBin = engineBin(process.platform === "win32" ? "tsx.cmd" : "tsx");
  const srcServer = path.join(engine, "src/ui/server/index.ts");
  if (fs.existsSync(tsxBin) && fs.existsSync(srcServer)) {
    return { cmd: tsxBin, args: [srcServer] };
  }

  if (fs.existsSync(builtServer)) {
    return { cmd: process.execPath, args: [builtServer] };
  }

  return { cmd: tsxBin, args: [srcServer] };
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

  const logFd = fs.openSync(logPath, "a");
  try {
    const child = spawn(
      entrypoint.cmd,
      [...entrypoint.args, ...(options.silent ? ["--silent"] : [])],
      {
        cwd: root,
        detached: true,
        env: {
          ...process.env,
          PORT: String(options.port),
          OP_ACCOUNT: process.env.OP_ACCOUNT ?? OP_ACCOUNT_DEFAULT,
        },
        stdio: ["ignore", logFd, logFd],
      },
    );
    child.unref();
    const started = { pid: child.pid, logPath };
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
        env: {
          ...process.env,
          PORT: String(port),
          OP_ACCOUNT: process.env.OP_ACCOUNT ?? OP_ACCOUNT_DEFAULT,
        },
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

function findDenWebPids(port: number): number[] {
  const root = getDistRoot();
  const pids = new Set<number>();
  const state = readWebServerState();
  if (state?.port === port && state.pid) {
    const command = commandForPid(state.pid);
    if (command && isDenWebCommand(command, webRoots(state.root || root))) {
      pids.add(state.pid);
    }
  }

  for (const pid of listListeningPids(port)) {
    if (isDenWebCommand(commandForPid(pid), webRoots(root))) {
      pids.add(pid);
    }
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

async function stopDenWebServer(port: number): Promise<StopServerResult> {
  const pids = findDenWebPids(port);
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

async function stopBrokenDenWebServer(port: number): Promise<boolean> {
  return (await stopDenWebServer(port)).stopped;
}

function recordRunningDenWebServer(port: number): void {
  const root = getDistRoot();
  const state = readWebServerState();
  if (state?.port === port && state.pid) {
    const command = commandForPid(state.pid);
    if (command && isDenWebCommand(command, webRoots(state.root || root)))
      return;
  }

  const pids = listListeningPids(port).filter((pid) =>
    isDenWebCommand(commandForPid(pid), webRoots(root)),
  );
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

function openOrFocusDenWebUrl(url: string, port: number): BrowserOpenResult {
  const focusResult = focusExistingBrowserTab(port);
  if (focusResult.status === "focused") return focusResult;

  if (focusResult.status === "error" && process.platform === "darwin") {
    return focusResult;
  }

  return openUrl(url);
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

export function displayWebHelp(): void {
  console.log(chalk.bold("\nUsage:"));
  console.log(
    `  ${product().cli} web [up|down|restart] [--port <port>] [--no-open] [--verbose]`,
  );
  console.log(`  ${product().cli} web --setup-browser-access`);
  console.log();
  console.log(chalk.bold("Actions:"));
  console.log(
    `  up                 Start or focus ${product().title} web (default)`,
  );
  console.log(
    `  down               Stop the ${product().title} web daemon only`,
  );
  console.log(`  restart            Stop then start ${product().title} web`);
  console.log("  (start/stop remain accepted as legacy aliases for up/down)");
  console.log();
  console.log(chalk.bold("Options:"));
  console.log("  --port, -p <port>  Use a non-default web port");
  console.log(
    "  --no-open          Start or check the server without opening a browser",
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

export async function cmdWeb(args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    displayWebHelp();
    return;
  }

  const options = parseWebCommandArgs(args);
  if (options.setupBrowserAccess) {
    setupBrowserAccess();
    return;
  }

  const url = buildDenWebUrl(options.port);

  if (options.action === "down") {
    const stopped = await stopDenWebServer(options.port);
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
    const stopped = await stopDenWebServer(options.port);
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
    const stopped = await stopBrokenDenWebServer(options.port);
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
      running = await waitForDenWeb(options.port);
      if (!running) {
        throw new Error(
          `${product().title} web did not become ready. See ${started.logPath}`,
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

  const browser = openOrFocusDenWebUrl(url, options.port);
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
  console.log(chalk.gray(`  Visit: ${url}\n`));
}
