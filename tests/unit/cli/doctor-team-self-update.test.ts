/**
 * Review M4 (0.4.46): server_agent.self_update is the person's, in
 * config/local/user.yml. Set in the team file it does nothing; doctor says
 * so and where it goes, so nobody believes it is on. Invented names only.
 */
import { describe, expect, it } from "@jest/globals";
import {
  selfUpdateLines,
  teamSelfUpdateKey,
} from "../../../src/ui/cli/doctor-command.js";

describe("doctor: self_update in the team file", () => {
  it("names it as doing nothing there, and where the person sets it", () => {
    const out = teamSelfUpdateKey(
      () => ({ server_agent: { self_update: "auto" } }),
      () => ({ server_agent: { self_update: "ask" } }),
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/server_agent\.self_update does nothing there/);
    expect(out[0]).toMatch(/config\/local\/user\.yml/);
  });

  it("says nothing when it isn't set there", () => {
    expect(teamSelfUpdateKey(() => ({}))).toEqual([]);
    expect(teamSelfUpdateKey(() => ({ server_agent: { git: "pr" } }))).toEqual(
      [],
    );
  });
});

describe("doctor: self_update always shows (SRV-P6)", () => {
  it("prints the value, where it came from and the checks, as a line and a JSON check", () => {
    const r = selfUpdateLines("Acme", {
      config: () => ({
        selfUpdate: "auto",
        selfUpdateFrom: "user",
        updateCheckMs: 30 * 60_000,
      }),
      state: () => null,
      orgFile: "acme.config.yml",
    });
    expect(r.lines).toEqual([
      "",
      "Acme doctor: New versions",
      "",
      expect.stringMatching(
        /^ {2}self_update {2}✓ {2}self_update: auto, set in config\/local\/user\.yml; no check yet/,
      ),
    ]);
    expect(r.check).toMatchObject({ id: "self_update", status: "ok" });
  });

  it("a config Den can't read says so (warn), never a guess", () => {
    const r = selfUpdateLines("Acme", {
      config: () => {
        throw new Error("server_agent.self_update (user.yml): ask or auto");
      },
      state: () => null,
      orgFile: "acme.config.yml",
    });
    expect(r.check).toMatchObject({
      id: "self_update",
      status: "warn",
      detail: expect.stringMatching(/ask or auto/),
    });
    expect(r.lines[3]).toMatch(/⚠/);
  });
});
