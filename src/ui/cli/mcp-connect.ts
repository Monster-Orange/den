/**
 * `<cli> mcp connect | disconnect | clients | config`: register this
 * distribution's MCP server with a developer's agents. Planning lives in
 * ../mcp/connect.ts; this file does the I/O.
 */
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import chalk from "chalk";
import {
  MCP_CLIENTS,
  findClient,
  genericSnippet,
  jsonHasEntry,
  mergeJsonConfig,
  serverSpec,
  type ConnectAction,
  type ConnectEnv,
  type McpClient,
  type Scope,
  type ServerSpec,
} from "../mcp/connect.js";
import { product } from "../../shared/product.js";
import { getDistRoot } from "../../shared/paths.js";
import { readWebPort } from "../../shared/edge/config.js";
import { DEFAULT_PORT } from "../../shared/constants.js";
import {
  classifyServerInfo,
  foreignServerMessage,
  ownServer,
  pickAnotherPortHint,
  type OwnServer,
} from "./server-identity.js";
import { readDenConfig, readMcpConfig } from "../../shared/den-config.js";

export const MCP_CONNECT_SUBCOMMANDS = [
  "connect",
  "disconnect",
  "clients",
  "config",
] as const;

function onPath(bin: string): boolean {
  const exts =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".EXE;.CMD").split(";")
      : [""];
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      try {
        fs.accessSync(path.join(dir, bin + ext), fs.constants.X_OK);
        return true;
      } catch {
        /* next */
      }
    }
  }
  return false;
}

function connectEnv(projectDir: string): ConnectEnv {
  return {
    home: os.homedir(),
    platform: process.platform,
    appData: process.env.APPDATA,
    projectDir,
    which: onPath,
    exists: (p) => fs.existsSync(p),
  };
}

interface Flags {
  clients: string[];
  all: boolean;
  project: string | null;
  port?: number;
  dryRun: boolean;
}

function parseFlags(argv: string[]): Flags {
  const f: Flags = { clients: [], all: false, project: null, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--all" || a === "-a") f.all = true;
    else if (a === "--dry-run" || a === "-n") f.dryRun = true;
    else if (a === "--project" || a === "-p") {
      const next = argv[i + 1];
      if (next && !next.startsWith("-") && !findClient(next)) {
        f.project = path.resolve(next);
        i++;
      } else f.project = process.env.DEN_INVOKE_CWD ?? process.cwd();
    } else if (a === "--port") {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n < 1 || n > 65535)
        throw new Error(`--port must be a port number`);
      f.port = n;
    } else if (a.startsWith("-")) throw new Error(`unknown flag ${a}`);
    else f.clients.push(a);
  }
  return f;
}

function spec(port?: number): ServerSpec {
  const cli = product().cli;
  const s = serverSpec({
    cli,
    distRoot: getDistRoot(),
    nodeBinDir: path.dirname(process.execPath),
    platform: process.platform,
    port,
  });
  if (!fs.existsSync(s.command))
    throw new Error(
      `${s.command} does not exist: run this from a distribution with a bin/${cli} shim`,
    );
  return s;
}

const show = (argv: string[]): string =>
  argv.map((a) => (/^[\w./:=@-]+$/.test(a) ? a : `'${a}'`)).join(" ");

function run(argv: string[]): { code: number; out: string } {
  const r = spawnSync(argv[0], argv.slice(1), { encoding: "utf-8" });
  return {
    code: r.status ?? 1,
    out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim(),
  };
}

function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf-8");
  } catch {
    return null;
  }
}

/** Write `text` to `file` atomically, keeping the previous copy as .bak. */
function writeConfig(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak`);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

function apply(
  a: ConnectAction,
  remove: boolean,
  dryRun: boolean,
): { ok: boolean; said: string } {
  if (a.kind === "json") {
    const before = readText(a.file);
    const after = mergeJsonConfig(
      before,
      a.key,
      a.name,
      remove ? null : a.entry,
    );
    if (!dryRun) writeConfig(a.file, after);
    return {
      ok: true,
      said: `${dryRun ? "would write" : remove ? "removed from" : "wrote"} ${a.file}`,
    };
  }
  if (remove) {
    if (!a.remove)
      return {
        ok: false,
        said: "remove it from the client's own MCP settings",
      };
    if (dryRun) return { ok: true, said: `would run ${show(a.remove)}` };
    const r = run(a.remove);
    return { ok: r.code === 0, said: r.out || show(a.remove) };
  }
  if (dryRun) return { ok: true, said: `would run ${show(a.add)}` };
  if (a.remove) run(a.remove);
  const r = run(a.add);
  return {
    ok: r.code === 0,
    said:
      r.code === 0 ? `ran ${a.add[0]} ${a.add.slice(1, 3).join(" ")}` : r.out,
  };
}

function status(
  c: McpClient,
  s: ServerSpec,
  scope: Scope,
  env: ConnectEnv,
): string {
  const a = c.plan(s, scope, env);
  if (a.kind === "json") {
    const st = jsonHasEntry(readText(a.file), a.key, a.name, a.entry);
    return st === "connected"
      ? chalk.green("connected")
      : st === "different"
        ? chalk.yellow("connected (different command: reconnect)")
        : chalk.gray("not connected");
  }
  if (!a.check) return chalk.gray("unknown (check the client's MCP list)");
  return run(a.check).code === 0
    ? chalk.green("connected")
    : chalk.gray("not connected");
}

/** How long `mcp connect` waits for /api/server-info before giving up. */
export const WEB_PROBE_TIMEOUT_MS = 1500;

/** What a probe of the web server's /api/server-info found. */
export type WebProbe =
  | { kind: "up"; version?: string }
  /** Another distribution's server (see server-identity.ts). */
  | { kind: "foreign"; who: string }
  /** Something accepted the connection but sent no answer in time. */
  | { kind: "timeout" }
  /** Nothing answered: connection refused, or not the web server. */
  | { kind: "down" };

export async function probeWebServer(
  url: string,
  timeoutMs: number = WEB_PROBE_TIMEOUT_MS,
  fetchImpl: typeof fetch = fetch,
  own: OwnServer = ownServer(),
): Promise<WebProbe> {
  try {
    const r = await fetchImpl(`${url}/api/server-info`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    const id = classifyServerInfo(await r.json(), own);
    if (id.kind === "foreign") return { kind: "foreign", who: id.who };
    return { kind: "up", version: id.kind === "ours" ? id.version : undefined };
  } catch (e) {
    return (e as Error).name === "TimeoutError"
      ? { kind: "timeout" }
      : { kind: "down" };
  }
}

/** Whether the org config runs the web UI as a service (`web.service`). */
function webRunsAsService(): boolean {
  try {
    return readDenConfig().web?.service !== undefined;
  } catch {
    return false;
  }
}

/**
 * The status line for a probe. A server that is up but slow is "not
 * answering", never "not running"; and when the web UI runs as a service
 * (`web.service`), the advice is the service's status, not `web up`.
 */
export function webServerMessage(
  probe: WebProbe,
  url: string,
  opts: { cli: string; asService: boolean; timeoutMs?: number },
): string {
  if (probe.kind === "up")
    return (
      chalk.green(`web server up at ${url}`) +
      (probe.version ? chalk.gray(` (Den ${probe.version})`) : "")
    );
  if (probe.kind === "foreign")
    return chalk.yellow(
      `${foreignServerMessage(Number(new URL(url).port), probe.who)}: ` +
        `agents would read another distribution; ${pickAnotherPortHint(opts.cli)}`,
    );
  const svc = `\`${opts.cli} service status\``;
  if (probe.kind === "timeout") {
    const secs = (opts.timeoutMs ?? WEB_PROBE_TIMEOUT_MS) / 1000;
    return chalk.yellow(
      `web server at ${url} is not answering within ${secs}s (busy or stuck): ` +
        `agents' reads wait on it too; if it stays slow, ` +
        (opts.asService
          ? `check ${svc}`
          : `restart it with \`${opts.cli} web restart\``),
    );
  }
  return chalk.yellow(
    `web server not running at ${url}: agents get read errors until ` +
      (opts.asService
        ? `the service is up (check ${svc})`
        : `\`${opts.cli} web up\``),
  );
}

function webUrl(port?: number): string {
  let p = port;
  if (p === undefined) {
    try {
      p = readWebPort();
    } catch {
      p = DEFAULT_PORT;
    }
  }
  return `http://localhost:${p}`;
}

async function webServerLine(port?: number, probe?: WebProbe): Promise<string> {
  const url = webUrl(port);
  return webServerMessage(probe ?? (await probeWebServer(url)), url, {
    cli: product().cli,
    asService: webRunsAsService(),
  });
}

function usage(): string {
  const cli = product().cli;
  return [
    `Usage:`,
    `  ${cli} mcp clients                       which agents are installed and connected`,
    `  ${cli} mcp connect [<client>...|--all]   register ${cli}'s MCP server (user scope)`,
    `        [--project [dir]]                  in a project's config instead (default: here)`,
    `        [--port <n>] [--dry-run]`,
    `  ${cli} mcp disconnect <client>... [--project [dir]]`,
    `  ${cli} mcp config [--port <n>]           JSON for any other MCP client`,
    ``,
    `Clients: ${MCP_CLIENTS.map((c) => c.id).join(", ")}`,
  ].join("\n");
}

export async function runMcpConnect(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv;
  if (rest.includes("-h") || rest.includes("--help")) {
    console.log(usage());
    return 0;
  }
  let flags: Flags;
  try {
    flags = parseFlags(rest);
  } catch (e) {
    console.error(chalk.red(`${(e as Error).message}\n`) + usage());
    return 1;
  }
  const s = spec(flags.port);
  const scope: Scope = flags.project ? "project" : "user";
  const env = connectEnv(
    flags.project ?? process.env.DEN_INVOKE_CWD ?? process.cwd(),
  );

  if (sub === "config") {
    console.log(genericSnippet(s));
    return 0;
  }

  if (sub === "clients") {
    console.log(
      chalk.bold(
        `\n  ${product().title} MCP server: ${s.command} ${s.args.join(" ")}`,
      ),
    );
    console.log(`  ${await webServerLine(flags.port)}`);
    const actions = readMcpConfig().actions;
    console.log(
      chalk.gray(
        `  tools: read${actions.length ? ` + actions ${actions.join(", ")}` : " only (mcp.actions is empty)"}\n`,
      ),
    );
    for (const c of MCP_CLIENTS) {
      const here = c.detect(env);
      const st =
        here && c.scopes.includes(scope)
          ? status(c, s, scope, env)
          : chalk.gray(here ? `no ${scope} scope` : "not installed");
      console.log(
        `  ${here ? "●" : "○"} ${c.id.padEnd(15)} ${c.title.padEnd(24)} ${st}`,
      );
    }
    console.log(
      chalk.gray(
        `\n  Connect: ${product().cli} mcp connect <client>   (or --all for every installed one)\n`,
      ),
    );
    return 0;
  }

  if (sub !== "connect" && sub !== "disconnect") {
    console.log(usage());
    return 1;
  }
  const remove = sub === "disconnect";
  let targets: McpClient[];
  if (flags.all)
    targets = MCP_CLIENTS.filter(
      (c) => c.detect(env) && c.scopes.includes(scope),
    );
  else {
    const unknown = flags.clients.filter((id) => !findClient(id));
    if (unknown.length) {
      console.error(
        chalk.red(`unknown client: ${unknown.join(", ")}\n`) + usage(),
      );
      return 1;
    }
    targets = flags.clients.map((id) => findClient(id)!);
  }
  if (targets.length === 0) {
    console.log(usage());
    return 1;
  }

  // Never point agents at another distribution's server.
  if (!remove) {
    const probe = await probeWebServer(webUrl(flags.port));
    if (probe.kind === "foreign") {
      console.error(
        `  ${chalk.red("✗")} ${await webServerLine(flags.port, probe)}`,
      );
      return 1;
    }
  }

  let failed = 0;
  for (const c of targets) {
    if (!c.scopes.includes(scope)) {
      console.log(`  ${chalk.yellow("•")} ${c.title}: no ${scope} scope`);
      failed++;
      continue;
    }
    try {
      const r = apply(c.plan(s, scope, env), remove, flags.dryRun);
      console.log(
        `  ${r.ok ? chalk.green("✓") : chalk.red("✗")} ${c.title}: ${r.said}`,
      );
      if (!r.ok) failed++;
    } catch (e) {
      console.log(`  ${chalk.red("✗")} ${c.title}: ${(e as Error).message}`);
      failed++;
    }
  }
  if (!remove && !flags.dryRun && failed < targets.length) {
    console.log(
      chalk.gray(
        `\n  Restart the agent (or start a new session) to load "${s.name}".`,
      ),
    );
    console.log(`  ${await webServerLine(flags.port)}\n`);
  }
  return failed ? 1 : 0;
}
