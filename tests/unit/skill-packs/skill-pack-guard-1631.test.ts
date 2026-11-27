import { describe, expect, it } from "@jest/globals";
import fs from "node:fs";
import path from "node:path";
import { skillsOf } from "../../../src/shared/skill-packs/config.js";
import { SKILL_PACKS_DIR } from "../../../src/shared/skill-packs/launch.js";
import { readPacks } from "../../../src/shared/skill-packs/pin.js";

const AROUND_DEN = [
  /never (call a tool that shows a person|ask (a |the )?(person|human|user))/i,
  /add no (check|gate|sign-off|review)/i,
  /(proceed|go ahead|continue)s? without asking/i,
  /poteto-mode|poteto-help|poteto-agent|worker\.md/i,
];
const DEN_OWN = new Set(["DEN-NOTICE.md"]);

describe("issue 1631: no vendored skill works around Den's asks and reviews", () => {
  const packs = readPacks(SKILL_PACKS_DIR);

  it("no file in any pack, on by default or not, says never ask a person, skip review, act without asking, or points at poteto-mode", () => {
    const hits: string[] = [];
    for (const name of Object.keys(packs))
      for (const rel of Object.keys(packs[name]!.files)) {
        if (DEN_OWN.has(rel)) continue;
        const text = fs.readFileSync(
          path.join(SKILL_PACKS_DIR, name, rel),
          "utf8",
        );
        for (const re of AROUND_DEN)
          if (re.test(text)) hits.push(`${name}/${rel}: ${re}`);
      }
    expect(hits).toEqual([]);
  });

  it("the pack ships without poteto-mode and its help skill, and the notice says why", () => {
    const pin = packs.pstack!;
    expect(skillsOf(pin)).not.toContain("poteto-mode");
    expect(skillsOf(pin)).not.toContain("poteto-help");
    expect(
      fs.existsSync(
        path.join(SKILL_PACKS_DIR, "pstack", "skills", "poteto-mode"),
      ),
    ).toBe(false);
    expect(
      fs.readFileSync(
        path.join(SKILL_PACKS_DIR, "pstack", "DEN-NOTICE.md"),
        "utf8",
      ),
    ).toMatch(/`skills\/poteto-mode`: .*never to ask/);
  });
});
