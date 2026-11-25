/**
 * Issue 646 (clause 3, point 5): doctor fails a project link whose Hub isn't
 * the connected one (another Hub, or another company on it), naming where
 * it points and where to link it again. Connected or not: the link is
 * wrong either way. Pure: hubProjectLines over invented projects.
 */
import { describe, expect, it } from "@jest/globals";
import { hubProjectLines } from "../../../src/ui/cli/doctor-command.js";

const elsewhere = {
  slug: "north",
  name: "North",
  origin: "https://hub-one.example.test",
  company: "acme",
};

describe("issue 646: doctor and a link to another Hub", () => {
  it("fails the link, naming the other Hub and company", () => {
    const r = hubProjectLines(
      true,
      [{ ws: "north", link: null, elsewhere }],
      "den",
    );
    const c = r.checks.find((x) => x.id === "hub:project:north");
    expect(c?.status).toBe("fail");
    expect(c?.detail).toContain("hub-one.example.test");
    expect(c?.detail).toContain("acme");
    expect(c?.detail).toContain("Settings › Hub");
    expect(r.lines.join("\n")).toMatch(/hub project {2}✗ {2}north:/);
    // One row for it: never also "not linked".
    expect(r.checks.filter((x) => x.id === "hub:project:north")).toHaveLength(
      1,
    );
  });

  it("fails it with Hub not connected too", () => {
    const r = hubProjectLines(
      false,
      [{ ws: "north", link: null, elsewhere }],
      "den",
    );
    expect(r.checks.map((x) => x.status)).toEqual(["fail"]);
  });

  it("a link on the connected Hub stays ok", () => {
    const r = hubProjectLines(
      true,
      [{ ws: "north", link: { slug: "north", name: "North" } }],
      "den",
    );
    expect(r.checks.map((x) => x.status)).toEqual(["ok"]);
  });
});
