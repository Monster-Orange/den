/**
 * `mcp connect --runtime <runtime>` (ON-2): an agent's own name maps to its
 * MCP client (claude → claude-code, codex, gemini, grok). Grok CLI keeps its
 * servers in ~/.grok/config.toml (or .grok/config.toml), one
 * [mcp_servers.<name>] table each (https://docs.x.ai/build/features/mcp-servers):
 * Den writes only its own table, keeps the rest of the file, and a re-run
 * changes nothing.
 */
import { describe, expect, it } from "@jest/globals";
import * as path from "path";
import {
  RUNTIME_CLIENTS,
  clientForRuntime,
  findClient,
  mergeTomlConfig,
  serverSpec,
  tomlHasEntry,
  type ConnectEnv,
} from "../../../src/ui/mcp/connect.js";

const env: ConnectEnv = {
  home: "/home/dev",
  platform: "linux",
  projectDir: "/work/shop",
  which: () => false,
  exists: () => false,
};
const spec = serverSpec({
  cli: "acme",
  distRoot: "/dist/acme",
  nodeBinDir: "/opt/node/bin",
  platform: "linux",
});

describe("--runtime", () => {
  it("maps each runtime to its client", () => {
    expect(RUNTIME_CLIENTS).toEqual({
      claude: "claude-code",
      codex: "codex",
      gemini: "gemini",
      grok: "grok",
    });
    for (const [rt, id] of Object.entries(RUNTIME_CLIENTS))
      expect(clientForRuntime(rt)?.id).toBe(id);
    expect(clientForRuntime("claude-code")).toBeUndefined();
    expect(clientForRuntime("nope")).toBeUndefined();
  });
});

describe("the grok client", () => {
  const grok = findClient("grok")!;

  it("plans one TOML table in ~/.grok/config.toml, or the project's", () => {
    expect(grok.scopes).toEqual(["user", "project"]);
    expect(grok.plan(spec, "user", env)).toEqual({
      kind: "toml",
      file: path.join("/home/dev", ".grok", "config.toml"),
      name: "acme",
      entry: {
        command: "/dist/acme/bin/acme",
        args: ["mcp"],
        env: {
          PATH: "/opt/node/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
        },
      },
    });
    expect(grok.plan(spec, "project", env)).toMatchObject({
      file: path.join("/work/shop", ".grok", "config.toml"),
    });
    expect(grok.detect({ ...env, which: (b) => b === "grok" })).toBe(true);
    expect(grok.detect(env)).toBe(false);
  });

  it("writes its table, keeps every other line, and a re-run is a no-op", () => {
    const a = grok.plan(spec, "user", env);
    if (a.kind !== "toml") throw new Error("not toml");
    const before = [
      'model = "grok-4"',
      "",
      "[mcp_servers.other]",
      'command = "other-server"',
      "",
      "[ui]",
      'theme = "dark"',
      "",
    ].join("\n");
    const once = mergeTomlConfig(before, a.name, a.entry);
    expect(once).toBe(
      [
        'model = "grok-4"',
        "",
        "[mcp_servers.other]",
        'command = "other-server"',
        "",
        "[ui]",
        'theme = "dark"',
        "",
        "[mcp_servers.acme]",
        'command = "/dist/acme/bin/acme"',
        'args = ["mcp"]',
        'env = { PATH = "/opt/node/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin" }',
        "",
      ].join("\n"),
    );
    expect(mergeTomlConfig(once, a.name, a.entry)).toBe(once);
    expect(tomlHasEntry(once, "acme", a.entry)).toBe("connected");
    expect(tomlHasEntry(before, "acme", a.entry)).toBe("absent");
    expect(
      tomlHasEntry(once, "acme", { ...a.entry, args: ["mcp", "--port", "1"] }),
    ).toBe("different");
  });

  it("replaces a stale table (and its sub-tables) in place, and removes it", () => {
    const stale = [
      "[mcp_servers.acme]",
      'command = "/old/bin/acme"',
      "[mcp_servers.acme.env]",
      'PATH = "/old"',
      "",
      "[mcp_servers.other]",
      'command = "x"',
      "",
    ].join("\n");
    const merged = mergeTomlConfig(stale, "acme", {
      command: "/new",
      args: [],
    });
    expect(merged).not.toMatch(/old/);
    expect(merged).toMatch(/\[mcp_servers\.other\]\ncommand = "x"/);
    expect(merged).toMatch(
      /\[mcp_servers\.acme\]\ncommand = "\/new"\nargs = \[\]/,
    );
    expect(mergeTomlConfig(merged, "acme", null)).toBe(
      '[mcp_servers.other]\ncommand = "x"\n',
    );
    expect(mergeTomlConfig(null, "acme", { command: "/a" })).toBe(
      '[mcp_servers.acme]\ncommand = "/a"\n',
    );
  });
});
