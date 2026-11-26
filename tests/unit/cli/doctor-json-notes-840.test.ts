import { describe, expect, it } from "@jest/globals";
import { strategyCheck } from "../../../src/ui/cli/doctor-command.js";

describe("doctor --json keeps a row's notes (issue 840)", () => {
  const row = {
    kind: "tls",
    selected: "files",
    implicit: false,
    available: true,
    problem: false,
    warnings: [],
    notes: ["edge.image traefik:v3.7 is Traefik v3: every flag Den sets works"],
  };

  it("a row with notes: the check has them, and id, status and detail are as before", () => {
    const c = strategyCheck(row);
    expect(c).toMatchObject({
      id: "strategy:tls",
      status: "ok",
      detail: "files available",
    });
    expect(c.notes).toEqual(row.notes);
  });

  it("a row with none: no notes field at all", () => {
    expect("notes" in strategyCheck({ ...row, notes: [] })).toBe(false);
    const { notes: _n, ...bare } = row;
    expect("notes" in strategyCheck(bare)).toBe(false);
  });
});
