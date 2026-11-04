/**
 * `<cli> mcp connect`: each client's plan for registering the server, and the
 * JSON merge that must never lose a developer's other servers.
 */
import { describe, expect, it } from "@jest/globals";
import {
  MCP_CLIENTS,
  findClient,
  genericSnippet,
  jsonHasEntry,
  mergeJsonConfig,
  serverSpec,
  type ConnectEnv,
} from "../../../src/ui/mcp/connect.js";

const spec = serverSpec({
  cli: "acme",
  distRoot: "/work/acme",
  nodeBinDir: "/home/dev/.nvm/versions/node/v24/bin",
  platform: "darwin",
});

const env = (over: Partial<ConnectEnv> = {}): ConnectEnv => ({
  home: "/home/dev",
  platform: "darwin",
  projectDir: "/work/shop",
  which: () => false,
  exists: () => false,
  ...over,
});

describe("serverSpec", () => {
  it("is the distribution's bin shim by absolute path, with node on PATH", () => {
    expect(spec).toEqual({
      name: "acme",
      command: "/work/acme/bin/acme",
      args: ["mcp"],
      env: {
        PATH: "/home/dev/.nvm/versions/node/v24/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
      },
    });
  });

  it("passes --port through", () => {
    expect(
      serverSpec({
        cli: "acme",
        distRoot: "/w",
        nodeBinDir: "/usr/local/bin",
        platform: "linux",
        port: 7790,
      }).args,
    ).toEqual(["mcp", "--port", "7790"]);
  });
});

describe("client plans", () => {
  it("Claude Code user scope uses its own CLI, idempotently", () => {
    const a = findClient("claude-code")!.plan(spec, "user", env());
    expect(a).toEqual({
      kind: "exec",
      remove: ["claude", "mcp", "remove", "--scope", "user", "acme"],
      add: [
        "claude",
        "mcp",
        "add",
        "--scope",
        "user",
        "-e",
        `PATH=${spec.env.PATH}`,
        "acme",
        "--",
        "/work/acme/bin/acme",
        "mcp",
      ],
      check: ["claude", "mcp", "get", "acme"],
    });
  });

  it("Claude Code project scope writes .mcp.json in the project", () => {
    expect(findClient("claude-code")!.plan(spec, "project", env())).toEqual({
      kind: "json",
      file: "/work/shop/.mcp.json",
      key: "mcpServers",
      name: "acme",
      entry: {
        command: "/work/acme/bin/acme",
        args: ["mcp"],
        env: spec.env,
      },
    });
  });

  it("VS Code project scope uses servers and type stdio", () => {
    const a = findClient("vscode")!.plan(spec, "project", env());
    expect(a).toMatchObject({
      kind: "json",
      file: "/work/shop/.vscode/mcp.json",
      key: "servers",
      entry: { type: "stdio", command: "/work/acme/bin/acme" },
    });
  });

  it("Claude Desktop's config is per platform", () => {
    const c = findClient("claude-desktop")!;
    expect(c.plan(spec, "user", env())).toMatchObject({
      file: "/home/dev/Library/Application Support/Claude/claude_desktop_config.json",
    });
    expect(c.plan(spec, "user", env({ platform: "linux" }))).toMatchObject({
      file: "/home/dev/.config/Claude/claude_desktop_config.json",
    });
  });

  it("Codex passes env with --env", () => {
    const a = findClient("codex")!.plan(spec, "user", env());
    expect(a.kind === "exec" && a.add).toEqual([
      "codex",
      "mcp",
      "add",
      "--env",
      `PATH=${spec.env.PATH}`,
      "acme",
      "--",
      "/work/acme/bin/acme",
      "mcp",
    ]);
  });

  it("every client plans its user scope (or only project) without throwing", () => {
    for (const c of MCP_CLIENTS)
      for (const s of c.scopes)
        expect(() => c.plan(spec, s, env())).not.toThrow();
  });

  it("detection follows PATH or the client's config dir", () => {
    const e = env({
      which: (b) => b === "claude",
      exists: (p) => p === "/home/dev/.cursor",
    });
    expect(MCP_CLIENTS.filter((c) => c.detect(e)).map((c) => c.id)).toEqual([
      "claude-code",
      "cursor",
    ]);
  });
});

describe("mergeJsonConfig", () => {
  const entry = { command: "/x", args: ["mcp"] };

  it("creates the file's shape from nothing", () => {
    expect(
      JSON.parse(mergeJsonConfig(null, "mcpServers", "acme", entry)),
    ).toEqual({
      mcpServers: { acme: entry },
    });
  });

  it("keeps every other key and server", () => {
    const before = JSON.stringify({
      theme: "dark",
      mcpServers: { other: { command: "o" } },
    });
    expect(
      JSON.parse(mergeJsonConfig(before, "mcpServers", "acme", entry)),
    ).toEqual({
      theme: "dark",
      mcpServers: { other: { command: "o" }, acme: entry },
    });
  });

  it("replaces its own entry and removes it on null", () => {
    const before = mergeJsonConfig(null, "mcpServers", "acme", {
      command: "old",
    });
    const after = mergeJsonConfig(before, "mcpServers", "acme", null);
    expect(JSON.parse(after)).toEqual({ mcpServers: {} });
  });

  it("refuses to rewrite a file it cannot parse", () => {
    expect(() =>
      mergeJsonConfig("{ nope", "mcpServers", "acme", entry),
    ).toThrow(/not valid JSON/);
    expect(() => mergeJsonConfig("[]", "mcpServers", "acme", entry)).toThrow(
      /not a JSON object/,
    );
  });
});

describe("jsonHasEntry", () => {
  const entry = { command: "/x", args: ["mcp"] };
  it("tells connected, different and absent apart", () => {
    const text = mergeJsonConfig(null, "mcpServers", "acme", entry);
    expect(jsonHasEntry(text, "mcpServers", "acme", entry)).toBe("connected");
    expect(jsonHasEntry(text, "mcpServers", "acme", { command: "/y" })).toBe(
      "different",
    );
    expect(jsonHasEntry(null, "mcpServers", "acme", entry)).toBe("absent");
  });
});

describe("genericSnippet", () => {
  it("is the mcpServers form most clients accept", () => {
    expect(JSON.parse(genericSnippet(spec))).toEqual({
      mcpServers: {
        acme: { command: spec.command, args: ["mcp"], env: spec.env },
      },
    });
  });
});
