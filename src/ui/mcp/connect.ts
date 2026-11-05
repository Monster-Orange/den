/**
 * `<cli> mcp connect`: register this distribution's MCP server with the
 * agents a developer uses, so nobody hand-edits an MCP config.
 *
 * Each client is a strategy: where its config lives (or which of its own
 * CLIs registers a server) and in which shape. Planning is pure (tests drive
 * it with a fake home and PATH); applying it writes one JSON key or runs the
 * client's own `mcp add`. Nothing else in a client's config is touched.
 *
 * The registered command is the distribution's bin shim by absolute path,
 * with PATH pinned so that GUI clients (which start without the login shell's
 * PATH, so without nvm's node) can launch it.
 */
import * as path from "path";

export type Scope = "user" | "project";

/** What gets registered: one stdio server. */
export interface ServerSpec {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface ConnectEnv {
  home: string;
  platform: NodeJS.Platform;
  /** %APPDATA% on Windows. */
  appData?: string;
  /** The project directory for project scope (where the agent runs). */
  projectDir: string;
  /** Whether an executable is on PATH. */
  which: (bin: string) => boolean;
  /** Whether a file or directory exists. */
  exists: (p: string) => boolean;
}

/** One change to make. */
export type ConnectAction =
  | {
      kind: "json";
      file: string;
      /** Top-level key holding the servers: mcpServers, or servers (VS Code). */
      key: "mcpServers" | "servers";
      name: string;
      entry: Record<string, unknown>;
    }
  | {
      kind: "exec";
      /** Run first, failure ignored: makes the add idempotent. */
      remove?: string[];
      add: string[];
      /** Exit 0 when the server is registered (for status). */
      check?: string[];
    };

export interface McpClient {
  id: string;
  title: string;
  scopes: Scope[];
  /** Whether the client looks installed here. */
  detect(env: ConnectEnv): boolean;
  plan(spec: ServerSpec, scope: Scope, env: ConnectEnv): ConnectAction;
}

const stdioEntry = (s: ServerSpec): Record<string, unknown> => ({
  command: s.command,
  args: s.args,
  ...(Object.keys(s.env).length ? { env: s.env } : {}),
});

const envFlags = (flag: string, env: Record<string, string>): string[] =>
  Object.entries(env).flatMap(([k, v]) => [flag, `${k}=${v}`]);

function appSupport(env: ConnectEnv, app: string): string {
  if (env.platform === "darwin")
    return path.join(env.home, "Library", "Application Support", app);
  if (env.platform === "win32")
    return path.join(
      env.appData ?? path.join(env.home, "AppData", "Roaming"),
      app,
    );
  return path.join(env.home, ".config", app);
}

const json = (
  file: string,
  spec: ServerSpec,
  key: "mcpServers" | "servers" = "mcpServers",
  entry: Record<string, unknown> = stdioEntry(spec),
): ConnectAction => ({ kind: "json", file, key, name: spec.name, entry });

export const MCP_CLIENTS: readonly McpClient[] = [
  {
    id: "claude-code",
    title: "Claude Code",
    scopes: ["user", "project"],
    detect: (e) => e.which("claude"),
    plan: (s, scope, e) =>
      scope === "project"
        ? json(path.join(e.projectDir, ".mcp.json"), s)
        : {
            kind: "exec",
            remove: ["claude", "mcp", "remove", "--scope", "user", s.name],
            add: [
              "claude",
              "mcp",
              "add",
              // The name first: claude's -e takes several values, so a name
              // after the env pairs is read as one more pair.
              s.name,
              "--scope",
              "user",
              ...envFlags("-e", s.env),
              "--",
              s.command,
              ...s.args,
            ],
            check: ["claude", "mcp", "get", s.name],
          },
  },
  {
    id: "codex",
    title: "Codex CLI",
    scopes: ["user"],
    detect: (e) => e.which("codex"),
    plan: (s) => ({
      kind: "exec",
      remove: ["codex", "mcp", "remove", s.name],
      add: [
        "codex",
        "mcp",
        "add",
        ...envFlags("--env", s.env),
        s.name,
        "--",
        s.command,
        ...s.args,
      ],
      check: ["codex", "mcp", "get", s.name],
    }),
  },
  {
    id: "cursor",
    title: "Cursor",
    scopes: ["user", "project"],
    detect: (e) => e.which("cursor") || e.exists(path.join(e.home, ".cursor")),
    plan: (s, scope, e) =>
      json(
        path.join(
          scope === "project" ? e.projectDir : e.home,
          ".cursor",
          "mcp.json",
        ),
        s,
      ),
  },
  {
    id: "vscode",
    title: "VS Code (Copilot agent)",
    scopes: ["user", "project"],
    detect: (e) => e.which("code"),
    plan: (s, scope, e) =>
      scope === "project"
        ? json(path.join(e.projectDir, ".vscode", "mcp.json"), s, "servers", {
            type: "stdio",
            ...stdioEntry(s),
          })
        : {
            kind: "exec",
            add: [
              "code",
              "--add-mcp",
              JSON.stringify({ name: s.name, type: "stdio", ...stdioEntry(s) }),
            ],
          },
  },
  {
    id: "claude-desktop",
    title: "Claude Desktop",
    scopes: ["user"],
    detect: (e) => e.exists(appSupport(e, "Claude")),
    plan: (s, _scope, e) =>
      json(path.join(appSupport(e, "Claude"), "claude_desktop_config.json"), s),
  },
  {
    id: "windsurf",
    title: "Windsurf",
    scopes: ["user"],
    detect: (e) =>
      e.which("windsurf") ||
      e.exists(path.join(e.home, ".codeium", "windsurf")),
    plan: (s, _scope, e) =>
      json(path.join(e.home, ".codeium", "windsurf", "mcp_config.json"), s),
  },
  {
    id: "gemini",
    title: "Gemini CLI",
    scopes: ["user", "project"],
    detect: (e) => e.which("gemini"),
    plan: (s, scope, e) =>
      json(
        path.join(
          scope === "project" ? e.projectDir : e.home,
          ".gemini",
          "settings.json",
        ),
        s,
      ),
  },
];

export function findClient(id: string): McpClient | undefined {
  return MCP_CLIENTS.find((c) => c.id === id);
}

/** The PATH a launched server needs: node's own directory first. */
export function serverPath(nodeBinDir: string, platform: NodeJS.Platform) {
  const base =
    platform === "win32"
      ? []
      : ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"];
  return [nodeBinDir, ...base.filter((d) => d !== nodeBinDir)].join(
    platform === "win32" ? ";" : ":",
  );
}

/** The server this distribution registers. */
export function serverSpec(o: {
  cli: string;
  distRoot: string;
  nodeBinDir: string;
  platform: NodeJS.Platform;
  port?: number;
}): ServerSpec {
  return {
    name: o.cli,
    command: path.join(o.distRoot, "bin", o.cli),
    args: ["mcp", ...(o.port !== undefined ? ["--port", String(o.port)] : [])],
    env: { PATH: serverPath(o.nodeBinDir, o.platform) },
  };
}

// ── JSON configs ────────────────────────────────────────────────────────────

/**
 * `text` (a client's config file, or null when absent) with `name` set under
 * `key`. Refuses to rewrite a file it cannot parse: a client's config is the
 * developer's, and clobbering it loses their other servers.
 */
export function mergeJsonConfig(
  text: string | null,
  key: string,
  name: string,
  entry: Record<string, unknown> | null,
): string {
  let doc: Record<string, unknown> = {};
  if (text !== null && text.trim()) {
    try {
      doc = JSON.parse(text) as Record<string, unknown>;
    } catch (e) {
      throw new Error(
        `not valid JSON (${(e as Error).message}); fix it or add the server by hand`,
      );
    }
    if (!doc || typeof doc !== "object" || Array.isArray(doc))
      throw new Error("not a JSON object; add the server by hand");
  }
  const servers =
    doc[key] && typeof doc[key] === "object" && !Array.isArray(doc[key])
      ? { ...(doc[key] as Record<string, unknown>) }
      : {};
  if (entry === null) delete servers[name];
  else servers[name] = entry;
  return `${JSON.stringify({ ...doc, [key]: servers }, null, 2)}\n`;
}

/** Whether a JSON config already registers `name` with this entry. */
export function jsonHasEntry(
  text: string | null,
  key: string,
  name: string,
  entry: Record<string, unknown>,
): "connected" | "different" | "absent" {
  if (!text) return "absent";
  try {
    const doc = JSON.parse(text) as Record<string, Record<string, unknown>>;
    const have = doc?.[key]?.[name];
    if (have === undefined) return "absent";
    return JSON.stringify(have) === JSON.stringify(entry)
      ? "connected"
      : "different";
  } catch {
    return "absent";
  }
}

/** A generic snippet for any other MCP client. */
export function genericSnippet(spec: ServerSpec): string {
  return JSON.stringify(
    { mcpServers: { [spec.name]: stdioEntry(spec) } },
    null,
    2,
  );
}
