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

  it("leaves long lines and flow maps elsewhere in the file as they were", () => {
    const long = "x".repeat(120);
    const before = [
      "# mine",
      "web:",
      `  note: this is a long line that yaml would fold at eighty columns ${long}`,
      "  ports: { a: 1, b: 2 }",
      "",
    ].join("\n");
    fs.writeFileSync(userFile(), before);
    cfg.setUserAgentSandbox("bo", false);
    const after = fs.readFileSync(userFile(), "utf-8");
    expect(after.startsWith(before)).toBe(true);
    expect(after).toContain("bo:\n    sandbox: off");
  });

  it("clearing drops only the agent's sandbox key, and its block when that was all", () => {
    fs.writeFileSync(
      userFile(),
      "# mine\nagents:\n  bo:\n    sandbox: off\n  cy:\n    sandbox: off\n    model: x\n",
    );
    expect(cfg.clearUserAgentSandbox("bo")).toBe(true);
    expect(cfg.clearUserAgentSandbox("cy")).toBe(true);
    const after = fs.readFileSync(userFile(), "utf-8");
    expect(after).toContain("# mine");
    expect(after).not.toContain("bo:");
    expect(after).toContain("cy:\n    model: x");
    expect(after).not.toContain("sandbox");
    // Nothing to clear: nothing written.
    const at = fs.statSync(userFile()).mtimeMs;
    expect(cfg.clearUserAgentSandbox("dee")).toBe(false);
    expect(fs.statSync(userFile()).mtimeMs).toBe(at);
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
