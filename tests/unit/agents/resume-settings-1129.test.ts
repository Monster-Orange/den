/**
 * Issue 1129 part B: agents.resume (the restart queue) is in Settings and
 * `config`: four rows in the Agents category, the page's POST field
 * agents_resume writing user.yml agents.resume.* (the rest of agents
 * stays), and the same ranges for `config agents.resume.batch=…`.
 */
import { describe, expect, it } from "@jest/globals";
import * as cliRows from "../../../src/shared/settings-cli-rows.js";
import { DOTTED } from "../../../src/ui/cli/config-command.js";
import { DEN_SETTINGS } from "../../../src/ui/server/public/settings-registry.js";

type Row = {
  id: string;
  category?: string;
  scope?: string;
  keys?: string[];
  control?: Record<string, unknown>;
  read?: (ctx: unknown) => unknown;
};
const rows = DEN_SETTINGS as Row[];
const row = (key: string) => rows.find((s) => s.keys?.includes(key));

describe("issue 1129: agents.resume in Settings and config", () => {
  it.each([
    ["agents_resume.batch", 0, 1000, undefined, 4],
    ["agents_resume.gap_seconds", 0, 3600, "s", 30],
    ["agents_resume.load_ceiling", 0, 10000, undefined, 12],
    ["agents_resume.max_wait_seconds", 0, 86400, "s", 600],
  ])(
    "%s has a row in Agents, a number from %d to %d",
    (key, min, max, unit, v) => {
      const r = row(key);
      expect(r).toMatchObject({
        category: "agents",
        scope: "user",
        control: { type: "number", min, max, ...(unit ? { unit } : {}) },
      });
      // It reads what GET /api/settings says.
      const sub = key.split(".")[1]!;
      expect(r!.read!({ data: { agents_resume: { [sub]: v } } })).toBe(v);
    },
  );

  it("the POST field writes user.yml agents.resume.*, and the rest of agents stays", () => {
    const user: Record<string, unknown> = {
      agents: { restore_on_boot: true },
    };
    expect(
      cliRows.patchCliRows(user, {
        agents_resume: { batch: 2, gap_seconds: 45, max_wait_seconds: 0 },
      }),
    ).toEqual({ ok: true });
    expect(user.agents).toEqual({
      restore_on_boot: true,
      resume: { batch: 2, gap_seconds: 45, max_wait_seconds: 0 },
    });
    // null clears one key; clearing the last one drops resume, not agents.
    cliRows.patchCliRows(user, {
      agents_resume: { batch: null, gap_seconds: null, max_wait_seconds: null },
    });
    expect(user.agents).toEqual({ restore_on_boot: true });
  });

  it("with no agents block, it makes one; emptied, it goes again", () => {
    const user: Record<string, unknown> = {};
    cliRows.patchCliRows(user, { agents_resume: { load_ceiling: 8 } });
    expect(user).toEqual({ agents: { resume: { load_ceiling: 8 } } });
    cliRows.patchCliRows(user, { agents_resume: { load_ceiling: null } });
    expect(user).toEqual({});
  });

  it.each([
    [{ batch: -1 }],
    [{ batch: 1.5 }],
    [{ batch: 1001 }],
    [{ gap_seconds: 3601 }],
    [{ load_ceiling: "8" }],
    [{ max_wait_seconds: 86401 }],
    [{ nope: 1 }],
  ])("refuses %j and changes nothing", (bad) => {
    const user: Record<string, unknown> = { agents: { resume: { batch: 3 } } };
    const r = cliRows.patchCliRows(user, { agents_resume: bad });
    expect(r.ok).toBe(false);
    expect(user).toEqual({ agents: { resume: { batch: 3 } } });
  });

  it("agents.resume is a person's setting: an agent never changes it", () => {
    expect(cliRows.PERSON_ONLY_SETTINGS).toContain("agents_resume");
  });

  it("config takes the same four keys, through the same field", () => {
    expect(DOTTED["agents.resume.batch"]).toEqual(["agents_resume", "batch"]);
    expect(DOTTED["agents.resume.gap_seconds"]).toEqual([
      "agents_resume",
      "gap_seconds",
    ]);
    expect(DOTTED["agents.resume.load_ceiling"]).toEqual([
      "agents_resume",
      "load_ceiling",
    ]);
    expect(DOTTED["agents.resume.max_wait_seconds"]).toEqual([
      "agents_resume",
      "max_wait_seconds",
    ]);
  });
});
