import { describe, expect, it } from "@jest/globals";
import type { GateBox } from "../../../src/shared/gates/boxes.js";
import { boxPinLines } from "../../../src/ui/cli/doctor-boxes.js";

const box = (name: string, version: string): GateBox =>
  ({
    name,
    ssh: `ci@${name}.test`,
    playwright: `ws://${name}.test:3931/`,
    playwright_version: version,
  }) as GateBox;

describe("doctor: a box's Playwright against the projects' pins (issue 1827)", () => {
  it("⚠ names the box, both versions and the project when they differ", () => {
    const r = boxPinLines(
      [box("m1", "1.61.1"), box("mini", "1.64.1")],
      [{ project: "web", version: "1.64.1" }],
    );
    expect(r.check).toEqual({
      id: "gate_box_playwright",
      status: "warn",
      detail:
        "box m1 serves Playwright 1.61.1; project web pins 1.64.1, so its browser runs skip this box",
    });
    expect(r.lines).toContain(
      "  ⚠  box m1 serves Playwright 1.61.1; project web pins 1.64.1, so its browser runs skip this box",
    );
  });

  it("✓ when every box serves every project's pin", () => {
    const r = boxPinLines(
      [box("m1", "1.61.1")],
      [
        { project: "web", version: "1.61.1" },
        { project: "api", version: "1.61.1" },
      ],
    );
    expect(r.check.status).toBe("ok");
    expect(r.check.detail).toBe(
      "every test box serves the Playwright its projects pin",
    );
  });

  it("no row with no boxes, or no project that pins Playwright", () => {
    expect(
      boxPinLines([], [{ project: "web", version: "1.61.1" }]).lines,
    ).toEqual([]);
    expect(boxPinLines([box("m1", "1.61.1")], []).lines).toEqual([]);
  });
});
