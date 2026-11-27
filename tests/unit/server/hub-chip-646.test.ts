/**
 * Issue 646 (mock v2, part 2; clause 2 and 4): the project header's Hub
 * chip names the connected company and the project ("<company> · <project>",
 * the company alone on a phone), with "Connected to <company> (<host>).
 * This project: <project>." as its title. A link to another Hub counts as
 * not linked: the project shows its own name, and the chip reads "Another
 * Hub" in the warn colour, opening Project setup. Invented names only.
 */
import { describe, expect, it } from "@jest/globals";
import {
  hubChipModel,
  projectLabel,
  projectNameSource,
} from "../../../src/ui/server/public/workspace-picker.js";

const data = {
  workspaces: {
    north: {
      name: "north (local)",
      hub_project: { id: "p1", slug: "north-star", name: "North Star" },
    },
    south: { name: "South" },
  },
  active: ["north", "south"],
};
const away = { ...data, hubElsewhere: { north: true } };
const HUB = { team: "Acme Co", url: "https://hub.example.test" };

describe("issue 646: a link to another Hub counts as not linked", () => {
  it("the project shows its own name, not the old Hub's", () => {
    expect(projectLabel(data, "north")).toBe("North Star");
    expect(projectLabel(away, "north")).toBe("north (local)");
    expect(projectNameSource(away, "north")).toBe("local");
  });
});

describe("issue 646: the project's Hub chip", () => {
  it("linked: <company> · <project>, the company alone on a phone, and its title", () => {
    expect(hubChipModel(data, "north", HUB)).toEqual({
      kind: "linked",
      company: "Acme Co",
      project: "North Star",
      host: "hub.example.test",
      href: "/settings?project=north#workspace",
    });
  });

  it("linked, the company not known yet: the project alone (Hub: <project>)", () => {
    expect(hubChipModel(data, "north", null)).toEqual({
      kind: "linked",
      company: "",
      project: "North Star",
      host: "",
      href: "/settings?project=north#workspace",
    });
  });

  it("a link to another Hub: Another Hub, warn, to Project setup", () => {
    expect(hubChipModel(away, "north", HUB)).toEqual({
      kind: "elsewhere",
      href: "/settings?project=north#workspace",
    });
  });

  it("not linked: no chip", () => {
    expect(hubChipModel(data, "south", HUB)).toBeNull();
  });
});
