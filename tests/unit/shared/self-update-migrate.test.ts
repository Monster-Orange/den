/**
 * Review M4 (0.4.48): server_agent.self_update moves from the team file
 * to the person's user.yml. A person's existing choice carries over: at
 * the first start Den copies it, once, with an audit row, and doctor says
 * so. Never a silent fall back to ask. From then on the team file's value
 * does nothing, so an agent working beside it can't switch on its own
 * Allow by adding it there later.
 *
 * Fakes for user.yml and the audit; invented names only.
 */
import { describe, expect, it } from "@jest/globals";
import type { UserConfig } from "../../../src/shared/den-config.js";
import {
  migrateSelfUpdate,
  readServerAgentConfig,
} from "../../../src/shared/den-config.js";
import { teamSelfUpdateKey } from "../../../src/ui/cli/doctor-command.js";

function fakeUser(start: UserConfig = {}) {
  let user: UserConfig = structuredClone(start);
  const rows: { verb: string; detail: string }[] = [];
  return {
    get user() {
      return user;
    },
    rows,
    deps: {
      read: () => structuredClone(user),
      merge: (p: Partial<UserConfig>) => {
        user = { ...user, ...p };
        return user;
      },
      audit: (r: { verb: "config-write"; detail: string }) => rows.push(r),
      at: new Date("2026-11-15T09:00:00Z"),
    },
  };
}

const team = (v: unknown) => ({ server_agent: { self_update: v } }) as never;

describe("self_update: the team file's value carries over once", () => {
  it("auto in the team file, nothing in user.yml: copied to user.yml, with where from, and an audit row", () => {
    const f = fakeUser({ editor: "vi" } as UserConfig);
    expect(migrateSelfUpdate(team("auto"), f.deps)).toEqual({
      value: "auto",
      from: "team",
    });
    expect(f.user.server_agent).toEqual({
      self_update: "auto",
      self_update_from: expect.stringMatching(/2026-11-15/),
    });
    expect((f.user as { editor?: string }).editor).toBe("vi");
    expect(f.rows).toHaveLength(1);
    expect(f.rows[0]).toEqual({
      verb: "config-write",
      detail: expect.stringMatching(/self_update: auto.*user\.yml/),
    });
  });

  it("before that first start Den still reads the team file's choice, never ask", () => {
    expect(readServerAgentConfig(team("auto"), undefined, {}).selfUpdate).toBe(
      "auto",
    );
  });

  it("nothing in either: user.yml gets ask, so a value added to the team file later does nothing", () => {
    const f = fakeUser();
    expect(migrateSelfUpdate({} as never, f.deps)).toEqual({
      value: "ask",
      from: "default",
    });
    expect(f.user.server_agent).toEqual({ self_update: "ask" });
    expect(f.rows).toHaveLength(1);
    // An agent adds auto to the team file afterwards: no second move.
    expect(migrateSelfUpdate(team("auto"), f.deps)).toBeNull();
    expect(f.user.server_agent).toEqual({ self_update: "ask" });
    expect(
      readServerAgentConfig(team("auto"), undefined, f.user).selfUpdate,
    ).toBe("ask");
  });

  it("already in user.yml: nothing moves, nothing written", () => {
    const f = fakeUser({ server_agent: { self_update: "ask" } });
    expect(migrateSelfUpdate(team("auto"), f.deps)).toBeNull();
    expect(f.user.server_agent).toEqual({ self_update: "ask" });
    expect(f.rows).toEqual([]);
  });

  it("a team value that isn't ask or auto is not copied (doctor names it)", () => {
    const f = fakeUser();
    expect(migrateSelfUpdate(team("yes"), f.deps)).toBeNull();
    expect(f.user.server_agent).toBeUndefined();
    expect(
      teamSelfUpdateKey(
        () => team("yes"),
        () => ({}),
      )[0],
    ).toMatch(/ask or auto/);
  });
});

describe("doctor: the team file's self_update, before and after the move", () => {
  it("not moved yet: says the next start copies it to user.yml", () => {
    const out = teamSelfUpdateKey(
      () => team("auto"),
      () => ({}),
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/next start/);
    expect(out[0]).toMatch(/config\/local\/user\.yml/);
  });

  it("moved: says it was copied, and that the team file's line can go", () => {
    const out = teamSelfUpdateKey(
      () => team("auto"),
      () => ({
        server_agent: {
          self_update: "auto",
          self_update_from: "den.yml, 2026-11-15",
        },
      }),
    );
    expect(out[0]).toMatch(/copied to config\/local\/user\.yml/);
    expect(out[0]).toMatch(/remove it/);
  });
});
