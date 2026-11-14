/**
 * Review M4 (0.4.46): server_agent.self_update is the person's, in
 * config/local/user.yml. Set in the team file it does nothing; doctor says
 * so and where it goes, so nobody believes it is on. Invented names only.
 */
import { describe, expect, it } from "@jest/globals";
import { teamSelfUpdateKey } from "../../../src/ui/cli/doctor-command.js";

describe("doctor: self_update in the team file", () => {
  it("names it as doing nothing there, and where the person sets it", () => {
    const out = teamSelfUpdateKey(() => ({
      server_agent: { self_update: "auto" },
    }));
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
