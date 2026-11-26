import { describe, expect, it } from "@jest/globals";
import type { DenConfig, UserConfig } from "../../../src/shared/den-config.js";
import {
  patchSkillPacksBody,
  skillPackAgents,
  skillPacksData,
} from "../../../src/ui/server/skill-pack-settings.js";

const den = { environments: [] } as unknown as DenConfig;

describe("issue 1631: Settings' skill-pack data", () => {
  it("names the pin, the licence, every skill with its description, and the skills on", () => {
    const d = skillPacksData({} as UserConfig, den);
    expect(d.on).toBe(true);
    const p = d.packs.find((x) => x.name === "pstack")!;
    expect(p.license).toBe("MIT");
    expect(p.commit.startsWith("41e4009")).toBe(true);
    expect(p.copyright).toContain("Lauren Tan");
    const tdd = p.skills.find((s) => s.name === "tdd")!;
    expect(tdd.on).toBe(true);
    expect(tdd.description.length).toBeGreaterThan(10);
    expect(p.skills.find((s) => s.name === "statechart")?.on).toBe(false);
    expect(p.skillsOn).toBe(p.skills.filter((s) => s.on).length);
    expect(p.tokens).toBeGreaterThan(0);
  });

  it("an excluded skill is off, and the pack off loads none and costs nothing", () => {
    const ex = skillPacksData(
      { skill_packs: { pstack: { exclude: ["tdd"] } } } as UserConfig,
      den,
    ).packs[0]!;
    expect(ex.skills.find((s) => s.name === "tdd")?.on).toBe(false);
    const off = skillPacksData(
      { skill_packs: { pstack: { on: false } } } as UserConfig,
      den,
    ).packs[0]!;
    expect(off.on).toBe(false);
    expect(off.skillsOn).toBe(0);
    expect(off.tokens).toBe(0);
  });

  it("the POST takes one key and value, checked as Den reads it", () => {
    const u: Record<string, unknown> = {};
    expect(
      patchSkillPacksBody(
        u,
        { key: "skill_packs.pstack.exclude", value: ["tdd"] },
        den,
      ),
    ).toEqual({ ok: true });
    expect(u).toEqual({ skill_packs: { pstack: { exclude: ["tdd"] } } });
    expect(
      patchSkillPacksBody(
        u,
        { key: "skill_packs.pstack.exclude", value: null },
        den,
      ),
    ).toEqual({ ok: true });
    expect(u).toEqual({});
    const bad = patchSkillPacksBody(
      u,
      { key: "skill_packs.pstack.skills", value: ["no-such-skill-xyz"] },
      den,
    );
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.error).not.toContain("no-such-skill-xyz");
    expect(
      patchSkillPacksBody(u, { key: "agents.sandbox", value: 1 }, den).ok,
    ).toBe(false);
  });
});

describe("issue 1631: Settings' skill-pack POST takes a list", () => {
  it("applies every edit or none", () => {
    const u: Record<string, unknown> = {};
    expect(
      patchSkillPacksBody(
        u,
        [
          { key: "skill_packs.pstack.skills", value: ["tdd", "statechart"] },
          { key: "skill_packs.pstack.exclude", value: null },
        ],
        den,
      ),
    ).toEqual({ ok: true });
    expect(u).toEqual({
      skill_packs: { pstack: { skills: ["tdd", "statechart"] } },
    });
    const bad = patchSkillPacksBody(
      u,
      [
        { key: "skill_packs.pstack.on", value: false },
        { key: "skill_packs.pstack.skills", value: ["no-such-skill-xyz"] },
      ],
      den,
    );
    expect(bad.ok).toBe(false);
    expect(u).toEqual({
      skill_packs: { pstack: { skills: ["tdd", "statechart"] } },
    });
    expect(patchSkillPacksBody(u, [], den).ok).toBe(false);
  });

  it("marks the skills on by default", () => {
    const p = skillPacksData({} as UserConfig, den).packs[0]!;
    expect(p.skills.find((s) => s.name === "statechart")?.byDefault).toBe(
      false,
    );
    expect(p.skills.find((s) => s.name === "tdd")?.byDefault).toBe(true);
    expect(p.path).toBe("pstack");
  });
});

describe("issue 1631: which agents a Settings change restarts", () => {
  it("names each agent whose own skill_packs key changed, once", () => {
    expect(
      skillPackAgents([
        { key: "agents.lane-1.skill_packs", value: "off" },
        { key: "skill_packs.pstack.on", value: false },
        { key: "agents.lane-1.skill_packs", value: "on" },
      ]),
    ).toEqual(["lane-1"]);
    expect(skillPackAgents({ key: "skill_packs.on", value: false })).toEqual(
      [],
    );
  });
});
