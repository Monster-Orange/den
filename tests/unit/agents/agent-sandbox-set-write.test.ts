/**
 * Issue 1328: setUserAgentSandbox writes only agents.<id>.sandbox in
 * user.yml, keeping comments and every other key. Its own file, with no
 * static import of Den's modules: den-config freezes its paths at load,
 * so DEN_ROOT is set first, then it is imported. Temp install root.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

type DenConfig = typeof import("../../../src/shared/den-config.js");
let cfg: DenConfig;
let tmp = "";
let saved: string | undefined;
const userFile = () => path.join(tmp, "den", "config", "local", "user.yml");

beforeAll(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-1328w-")));
  const root = path.join(tmp, "den");
  fs.mkdirSync(path.join(root, "config", "local"), { recursive: true });
  fs.writeFileSync(path.join(root, "den.yml"), "product:\n  name: den\n");
  saved = process.env.DEN_ROOT;
  process.env.DEN_ROOT = root;
  cfg = await import("../../../src/shared/den-config.js");
});

afterAll(() => {
  if (saved === undefined) delete process.env.DEN_ROOT;
  else process.env.DEN_ROOT = saved;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("setUserAgentSandbox: only agents.<id>.sandbox (issue 1328)", () => {
  it("keeps comments and every other key; creates the agent's block when none", () => {
    fs.writeFileSync(
      userFile(),
      [
        "# my notes, keep these",
        "agents:",
        "  sandbox: on # the default",
        "  ana:",
        "    grants: [south]",
        "theme: dark",
        "",
      ].join("\n"),
    );
    cfg.setUserAgentSandbox("ana", false);
    cfg.setUserAgentSandbox("bo", false);
    const text = fs.readFileSync(userFile(), "utf-8");
    // The temp root's file, never another install's.
    expect(text).toContain("bo:\n    sandbox: off");
    expect(text).toContain("# my notes, keep these");
    expect(text).toContain("sandbox: on # the default");
    expect(text).toContain("theme: dark");
    const u = cfg.readUserConfig() as Record<string, unknown>;
    expect(u.agents).toEqual({
      sandbox: "on",
      ana: { grants: ["south"], sandbox: "off" },
      bo: { sandbox: "off" },
    });
    cfg.setUserAgentSandbox("ana", true);
    expect(
      (cfg.readUserConfig() as { agents: { ana: unknown } }).agents.ana,
    ).toEqual({ grants: ["south"], sandbox: "on" });
  });

  it("no user.yml yet: makes one with just that key", () => {
    fs.rmSync(userFile(), { force: true });
    cfg.setUserAgentSandbox("ana", false);
    expect(cfg.readUserConfig()).toEqual({
      agents: { ana: { sandbox: "off" } },
    });
  });

  it("refuses an agent id that isn't one, and an agents block that isn't a map", () => {
    expect(() => cfg.setUserAgentSandbox("../x", false)).toThrow(/agent id/);
    fs.writeFileSync(userFile(), "agents: [1]\n");
    expect(() => cfg.setUserAgentSandbox("ana", false)).toThrow(/agents/);
  });
});
