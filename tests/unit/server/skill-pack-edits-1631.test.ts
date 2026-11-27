import { describe, expect, it } from "@jest/globals";
import { skillPackEdits } from "../../../src/ui/server/public/settings-registry.js";

const pack = {
  name: "pstack",
  skills: [
    { name: "tdd", byDefault: true },
    { name: "why", byDefault: true },
    { name: "statechart", byDefault: false },
  ],
};

describe("issue 1631: what the Skills checkboxes write", () => {
  it("unchecking a default skill writes exclude, and every default checked writes skills: all", () => {
    expect(skillPackEdits(pack, ["tdd"])).toEqual([
      { key: "skill_packs.pstack.skills", value: null },
      { key: "skill_packs.pstack.exclude", value: ["why"] },
    ]);
    expect(skillPackEdits(pack, ["tdd", "why"])).toEqual([
      { key: "skill_packs.pstack.skills", value: null },
      { key: "skill_packs.pstack.exclude", value: null },
    ]);
  });

  it("checking a skill that's off by default writes the list", () => {
    expect(skillPackEdits(pack, ["why", "statechart"])).toEqual([
      { key: "skill_packs.pstack.skills", value: ["statechart", "why"] },
      { key: "skill_packs.pstack.exclude", value: null },
    ]);
  });
});
