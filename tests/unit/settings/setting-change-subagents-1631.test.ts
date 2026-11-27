import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  checkSettingChange,
  settingKind,
  type SettingChangeDeps,
} from "../../../src/ui/cli/setting-change.js";
import type { DenConfig } from "../../../src/shared/den-config.js";

let dir = "";
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-1631-sc-"));
  const f = path.join(dir, "config", "local", "user.yml");
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, "install_mode: strict\n");
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const deps = (): SettingChangeDeps => ({
  userFile: path.join(dir, "config", "local", "user.yml"),
  backupDir: path.join(dir, "state", "settings-backups"),
  denConfig: () => ({ environments: [] }) as unknown as DenConfig,
  audit: () => {},
  now: () => "2026-11-25T20:00:00.000Z",
});

const kindOf = (key: string, value: unknown) => {
  const c = checkSettingChange(deps(), {
    key,
    value,
    reason: "a swarm needs room",
  });
  if (!c.ok) throw new Error(c.error);
  return c.kind;
};

describe("issue 1631: setting_change on the subagent limits", () => {
  it("both are limits", () => {
    expect(settingKind("agents.max_subagents").category).toBe("limits");
    expect(settingKind("agents.subagents_respect_load_hold").category).toBe(
      "limits",
    );
  });

  it("max_subagents: lowering it, or raising it up to twice the value in force, runs at once; past that it asks", () => {
    expect(kindOf("agents.max_subagents", 4).widens).toBe(false);
    expect(kindOf("agents.max_subagents", 16).widens).toBe(false);
    expect(kindOf("agents.max_subagents", 17).widens).toBe(true);
  });

  it("the load hold: on runs at once; off asks on a strict install, not on a personal one", () => {
    expect(kindOf("agents.subagents_respect_load_hold", true).widens).toBe(
      false,
    );
    expect(kindOf("agents.subagents_respect_load_hold", false).widens).toBe(
      true,
    );
    expect(
      settingKind("agents.subagents_respect_load_hold", "personal", false)
        .widens,
    ).toBe(false);
  });

  it("a bad value is refused with den-config's words", () => {
    const c = checkSettingChange(deps(), {
      key: "agents.subagents_respect_load_hold",
      value: "maybe",
      reason: "a swarm needs room",
    });
    expect(c.ok).toBe(false);
    expect(!c.ok && c.error).toMatch(/true or false/);
  });
});
