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
const userFile = () => path.join(dir, "config", "local", "user.yml");
const write = (text: string) => fs.writeFileSync(userFile(), text);
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-1631-scp-"));
  fs.mkdirSync(path.dirname(userFile()), { recursive: true });
  write("install_mode: strict\n");
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const deps = (): SettingChangeDeps => ({
  userFile: userFile(),
  backupDir: path.join(dir, "state", "settings-backups"),
  denConfig: () => ({ environments: [] }) as unknown as DenConfig,
  audit: () => {},
  now: () => "2026-11-25T20:00:00.000Z",
});

const ask = (key: string, value: unknown) =>
  checkSettingChange(deps(), { key, value, reason: "fewer skills" });
const kindOf = (key: string, value: unknown) => {
  const c = ask(key, value);
  if (!c.ok) throw new Error(c.error);
  return c.kind;
};

describe("issue 1631: setting_change on the skill_packs keys", () => {
  it("every skill_packs key is an integration", () => {
    for (const k of [
      "skill_packs.on",
      "skill_packs.pstack.on",
      "skill_packs.pstack.skills",
      "skill_packs.pstack.exclude",
      "agents.lane-1.skill_packs",
    ])
      expect(settingKind(k).category).toBe("integrations");
  });

  it("turning a pack off runs at once on both modes", () => {
    expect(kindOf("skill_packs.on", false).widens).toBe(false);
    expect(kindOf("skill_packs.pstack.on", false).widens).toBe(false);
    expect(kindOf("agents.lane-1.skill_packs", "off").widens).toBe(false);
    expect(kindOf("skill_packs.pstack.exclude", ["tdd"]).widens).toBe(false);
    expect(kindOf("skill_packs.pstack.skills", ["tdd"]).widens).toBe(false);
    write("install_mode: personal\n");
    expect(kindOf("skill_packs.pstack.on", false).widens).toBe(false);
    expect(kindOf("agents.lane-1.skill_packs", "off").widens).toBe(false);
  });

  it("turning one back on, or adding skills, asks on strict, and runs at once on personal", () => {
    write(
      "install_mode: strict\nskill_packs:\n  on: false\n  pstack:\n    on: false\n    skills: [tdd]\n    exclude: [why]\nagents:\n  lane-1:\n    skill_packs: off\n",
    );
    expect(kindOf("skill_packs.on", true).widens).toBe(true);
    expect(kindOf("skill_packs.pstack.on", true).widens).toBe(true);
    expect(kindOf("agents.lane-1.skill_packs", "on").widens).toBe(true);
    expect(kindOf("skill_packs.pstack.skills", ["tdd", "why"]).widens).toBe(
      true,
    );
    expect(kindOf("skill_packs.pstack.skills", "all").widens).toBe(true);
    expect(kindOf("skill_packs.pstack.exclude", []).widens).toBe(true);
    write("install_mode: personal\nskill_packs:\n  pstack:\n    on: false\n");
    expect(kindOf("skill_packs.pstack.on", true).widens).toBe(false);
  });

  it("adding a skill the pin keeps off by default widens, even from all", () => {
    expect(
      kindOf("skill_packs.pstack.skills", ["tdd", "statechart"]).widens,
    ).toBe(true);
  });

  it("the card shows Now and New", () => {
    const c = ask("skill_packs.pstack.on", false);
    expect(c.ok && c.details.join("\n")).toMatch(/Now: .*\n.*New: false/s);
  });

  it("an unknown skill or pack is refused without echoing it", () => {
    const c = ask("skill_packs.pstack.skills", ["no-such-skill-xyz"]);
    expect(c.ok).toBe(false);
    expect(!c.ok && c.error).not.toContain("no-such-skill-xyz");
    const p = ask("agents.lane-1.skill_packs", ["no-such-pack-xyz"]);
    expect(p.ok).toBe(false);
    expect(!p.ok && p.error).not.toContain("no-such-pack-xyz");
    const n = ask("skill_packs.nopack.on", false);
    expect(n.ok).toBe(false);
  });
});
