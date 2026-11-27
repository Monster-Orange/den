import { afterEach, describe, expect, it } from "@jest/globals";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  agentSkillPacks,
  personOwnPlugins,
  readSkillPacksConfig,
} from "../../../src/shared/skill-packs/launch";
import { readPacks } from "../../../src/shared/skill-packs/pin";

const PACKS_DIR = path.resolve(__dirname, "../../../skill-packs");
const packs = readPacks(PACKS_DIR);

const dirs: string[] = [];
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "den-1631-agent-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) {
    fs.chmodSync(d, 0o700);
    for (const f of fs.readdirSync(d, { recursive: true }) as string[])
      fs.chmodSync(path.join(d, f), 0o700);
    fs.rmSync(d, { recursive: true, force: true });
  }
});

const base = (over: Partial<Parameters<typeof agentSkillPacks>[0]> = {}) => ({
  stateDir: tmp(),
  runtimeId: "den-claude",
  install: readSkillPacksConfig(undefined, undefined, packs),
  persona: undefined,
  agent: undefined,
  claudeConfigDir: tmp(),
  packsDir: PACKS_DIR,
  ...over,
});

describe("issue 1631: the packs one agent's start loads", () => {
  it("by default a Claude Code agent gets a built pstack folder in the state folder", () => {
    const o = base();
    const got = agentSkillPacks(o);
    expect(got.packs.map((p) => p.name)).toEqual(["pstack"]);
    const dir = got.packs[0]!.dir;
    expect(
      dir.startsWith(path.join(o.stateDir, "skill-packs", "pstack@")),
    ).toBe(true);
    expect(fs.existsSync(path.join(dir, "skills", "tdd", "SKILL.md"))).toBe(
      true,
    );
    expect(fs.existsSync(path.join(dir, "skills", "statechart"))).toBe(false);
  });

  it("the agent's off, the persona's off, and skill_packs.on: false each load nothing", () => {
    expect(agentSkillPacks(base({ agent: "off" })).packs).toEqual([]);
    expect(agentSkillPacks(base({ persona: "off" })).packs).toEqual([]);
    expect(
      agentSkillPacks(base({ persona: "off", agent: "on" })).packs,
    ).toHaveLength(1);
    const off = readSkillPacksConfig({ on: false }, undefined, packs);
    expect(agentSkillPacks(base({ install: off, agent: "on" })).packs).toEqual(
      [],
    );
  });

  it("user.yml wins over den.yml key by key", () => {
    const c = readSkillPacksConfig(
      { pstack: { on: false, exclude: ["arena"] } },
      { pstack: { on: true } },
      packs,
    );
    expect(c.packs.pstack!.on).toBe(true);
    expect(c.packs.pstack!.exclude).toEqual(["arena"]);
    expect(readSkillPacksConfig({ on: true }, { on: false }, packs).on).toBe(
      false,
    );
  });

  it("a bad value names the file it is in", () => {
    expect(() =>
      readSkillPacksConfig(undefined, { pstack: { skills: ["nope"] } }, packs),
    ).toThrow(/user\.yml skill_packs\.pstack\.skills\[0\]/);
    expect(() => readSkillPacksConfig({ on: 1 }, undefined, packs)).toThrow(
      /den\.yml skill_packs\.on/,
    );
    expect(() => agentSkillPacks(base({ agent: 7 }))).toThrow(/skill_packs/);
  });

  it("another runtime loads nothing, and says so", () => {
    const got = agentSkillPacks(base({ runtimeId: "generic" }));
    expect(got.packs).toEqual([]);
    expect(got.note).toMatch(/Not used by this runtime/);
  });

  it("a pstack the person installed in Claude Code themselves is used instead of Den's copy", () => {
    const cfg = tmp();
    fs.mkdirSync(path.join(cfg, "plugins"));
    fs.writeFileSync(
      path.join(cfg, "plugins", "installed_plugins.json"),
      JSON.stringify({
        version: 2,
        plugins: { "pstack@cursor-plugins": [{}] },
      }),
    );
    expect(personOwnPlugins(cfg)).toEqual(["pstack"]);
    const got = agentSkillPacks(base({ claudeConfigDir: cfg }));
    expect(got.packs).toEqual([]);
    expect(got.note).toMatch(/your own pstack/);
    fs.writeFileSync(
      path.join(cfg, "plugins", "installed_plugins.json"),
      "{not json",
    );
    expect(personOwnPlugins(cfg)).toEqual([]);
  });
});
