import { describe, expect, it } from "@jest/globals";
import {
  parseCliArgs,
  takeWorkspaceFlags,
  unknownCommandFlags,
  workspaceFlagRequiresActive,
} from "../../../src/ui/cli/flag-parser.js";

describe("workspaceFlagRequiresActive", () => {
  it("requires an active workspace for commands that change what is running", () => {
    for (const command of ["up", "down", "restart"]) {
      expect(workspaceFlagRequiresActive(command)).toBe(true);
    }
  });

  it("does not require activation to READ a workspace", () => {
    // `/api/graph` has always allowed graphing any workspace; requiring
    // activation here would also regress the pre-multi-active `-w`, which
    // meant "use this workspace for this command only".
    for (const command of ["status", "logs", "services", "graph"]) {
      expect(workspaceFlagRequiresActive(command)).toBe(false);
    }
  });
});

describe("parseCliArgs", () => {
  it("supports workspace flag before the command", () => {
    expect(parseCliArgs(["-w", "default", "up", "api"])).toEqual({
      command: "up",
      args: ["api"],
      flags: { workspace: "default" },
    });
  });

  it("supports workspace flag after the command", () => {
    expect(parseCliArgs(["up", "-w", "default", "api"])).toEqual({
      command: "up",
      args: ["api"],
      flags: { workspace: "default" },
    });
  });

  it("supports tab flags on up and restart", () => {
    expect(parseCliArgs(["up", "--tabs"]).flags.forceTabs).toBe(true);
    expect(parseCliArgs(["restart", "--no-tabs"]).flags.forceTabs).toBe(false);
  });

  it("rejects tab flags on status", () => {
    expect(() => parseCliArgs(["status", "--tabs"])).toThrow(
      /not valid with status/,
    );
  });

  it("scopes skip secrets to up and restart", () => {
    expect(parseCliArgs(["up", "--skip-secrets"]).flags.skipSecrets).toBe(true);
    expect(() => parseCliArgs(["status", "--skip-secrets"])).toThrow(
      /not valid with status/,
    );
  });

  it("rejects workspace use with workspace override", () => {
    expect(() =>
      parseCliArgs(["workspace", "use", "-w", "default", "feature"]),
    ).toThrow(/workspace mutations/);
  });

  it("supports the --workspace=<name> equals form", () => {
    expect(parseCliArgs(["up", "--workspace=default", "api"])).toEqual({
      command: "up",
      args: ["api"],
      flags: { workspace: "default" },
    });
    expect(parseCliArgs(["-w=default", "up"])).toEqual({
      command: "up",
      args: [],
      flags: { workspace: "default" },
    });
  });

  it("rejects an empty equals-form workspace value", () => {
    expect(() => parseCliArgs(["up", "--workspace="])).toThrow(
      /--workspace requires a value/,
    );
  });

  it("passes arguments after -- through, keeping the terminator", () => {
    expect(parseCliArgs(["up", "--", "--weird-arg"])).toEqual({
      command: "up",
      args: ["--", "--weird-arg"],
      flags: {},
    });
  });

  it("does not consume global flags after --", () => {
    expect(parseCliArgs(["up", "--", "-w", "other"])).toEqual({
      command: "up",
      args: ["--", "-w", "other"],
      flags: {},
    });
  });
});

describe("unknownCommandFlags", () => {
  it("flags a typo'd --dry-run on up", () => {
    expect(unknownCommandFlags("up", ["--dyr-run"])).toEqual(["--dyr-run"]);
  });

  it("accepts every documented up flag", () => {
    expect(
      unknownCommandFlags("up", [
        "--manifest",
        "--no-derive",
        "-x",
        "--exclude",
        "-n",
        "--dry-run",
        "--plan",
        "--pull",
        "my-repo",
      ]),
    ).toEqual([]);
  });

  it("accepts down/setup flags and rejects strays on restart and sync", () => {
    expect(unknownCommandFlags("down", ["--dry-run", "api"])).toEqual([]);
    expect(unknownCommandFlags("setup", ["--force", "-f"])).toEqual([]);
    expect(unknownCommandFlags("restart", ["--foo"])).toEqual(["--foo"]);
    expect(unknownCommandFlags("sync", ["-q"])).toEqual(["-q"]);
  });

  it("accepts -a/--all on up and down, rejects it elsewhere", () => {
    expect(unknownCommandFlags("up", ["-a"])).toEqual([]);
    expect(unknownCommandFlags("up", ["--all", "-n"])).toEqual([]);
    expect(unknownCommandFlags("down", ["-a", "--dry-run"])).toEqual([]);
    expect(unknownCommandFlags("down", ["--all"])).toEqual([]);
    expect(unknownCommandFlags("logs", ["-a"])).toEqual(["-a"]);
    expect(unknownCommandFlags("setup", ["--all"])).toEqual(["--all"]);
  });

  it("ignores dash-args after the -- terminator", () => {
    expect(unknownCommandFlags("up", ["--", "--weird-arg"])).toEqual([]);
    expect(unknownCommandFlags("up", ["--bad", "--", "--ok"])).toEqual([
      "--bad",
    ]);
  });

  it("does not check commands without an allowlist", () => {
    expect(unknownCommandFlags("status", ["--verbose"])).toEqual([]);
    expect(unknownCommandFlags("graph", ["--format=json"])).toEqual([]);
  });
});

describe("commands that read -w themselves (0.2.8)", () => {
  it("setup keeps every -w in its args, so several can be planned", () => {
    expect(
      parseCliArgs([
        "setup",
        "--plan",
        "-w",
        "smb",
        "--workspace=ent",
        "-w",
        "x",
      ]),
    ).toEqual({
      command: "setup",
      args: ["--plan", "-w", "smb", "--workspace=ent", "-w", "x"],
      flags: {},
    });
    expect(
      unknownCommandFlags("setup", [
        "--plan",
        "-w",
        "smb",
        "--workspace=ent",
        "--all-active",
      ]),
    ).toEqual([]);
  });

  it("mcp keeps --workspace for its scope (never the CLI's override)", () => {
    expect(
      parseCliArgs(["mcp", "--workspace", "smb", "--actor", "agent:p"]),
    ).toEqual({
      command: "mcp",
      args: ["--workspace", "smb", "--actor", "agent:p"],
      flags: {},
    });
  });

  it("register takes -w as the workspace to write", () => {
    expect(parseCliArgs(["register", "../shop", "-w", "smb"])).toEqual({
      command: "register",
      args: ["../shop"],
      flags: { workspace: "smb" },
    });
  });

  it("takeWorkspaceFlags: every -w, in order, and the rest", () => {
    expect(
      takeWorkspaceFlags(["--plan", "-w", "a", "--workspace=b", "shop"]),
    ).toEqual({ workspaces: ["a", "b"], rest: ["--plan", "shop"] });
    expect(() => takeWorkspaceFlags(["-w"])).toThrow(/-w requires a value/);
    expect(() => takeWorkspaceFlags(["-w="])).toThrow(/-w requires a value/);
  });
});
