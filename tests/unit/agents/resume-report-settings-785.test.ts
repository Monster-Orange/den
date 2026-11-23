/**
 * Issue 785: the resume report's limits are settings with permissive
 * defaults (user.yml agents.resume_first_line_max_bytes, 1 MiB, and
 * agents.resume_report_min_seconds, 5), in Settings › Agents and `config`,
 * a person's to change, never an agent's.
 */
import { describe, expect, it } from "@jest/globals";
import {
  AGENTS_RESERVED_KEYS,
  resumeReportLimits,
} from "../../../src/shared/den-config.js";
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
const row = (key: string) =>
  (DEN_SETTINGS as Row[]).find((s) => s.keys?.includes(key));

describe("issue 785: the resume report's limits", () => {
  it("unset: 1 MiB and 5 s; a value out of range is its default", () => {
    expect(resumeReportLimits(() => ({}))).toEqual({
      firstLineMaxBytes: 1024 * 1024,
      minSeconds: 5,
    });
    expect(
      resumeReportLimits(() => ({
        agents: {
          resume_first_line_max_bytes: 65536,
          resume_report_min_seconds: 0,
        },
      })),
    ).toEqual({ firstLineMaxBytes: 65536, minSeconds: 0 });
    expect(
      resumeReportLimits(() => ({
        agents: {
          resume_first_line_max_bytes: 10.5,
          resume_report_min_seconds: -1,
        },
      })),
    ).toEqual({ firstLineMaxBytes: 1024 * 1024, minSeconds: 5 });
    expect(
      resumeReportLimits(() => {
        throw new Error("unreadable");
      }),
    ).toEqual({ firstLineMaxBytes: 1024 * 1024, minSeconds: 5 });
  });

  it.each([
    ["agents_resume_report.first_line_max_bytes", 4096, 67108864, "B", 2048000],
    ["agents_resume_report.min_seconds", 0, 3600, "s", 9],
  ])("%s has a row in Agents, from %d to %d", (key, min, max, unit, v) => {
    const r = row(key);
    expect(r).toMatchObject({
      category: "agents",
      scope: "user",
      control: { type: "number", min, max, unit },
    });
    const sub = key.split(".")[1]!;
    expect(r!.read!({ data: { agents_resume_report: { [sub]: v } } })).toBe(v);
  });

  it("the POST field writes user.yml agents.*, the rest of agents stays; out of range is refused", () => {
    const user: Record<string, unknown> = { agents: { restore_on_boot: true } };
    expect(
      cliRows.patchCliRows(user, {
        agents_resume_report: { first_line_max_bytes: 65536, min_seconds: 2 },
      }),
    ).toEqual({ ok: true });
    expect(user.agents).toEqual({
      restore_on_boot: true,
      resume_first_line_max_bytes: 65536,
      resume_report_min_seconds: 2,
    });
    for (const bad of [
      { first_line_max_bytes: 100 },
      { first_line_max_bytes: 1.5e8 },
      { first_line_max_bytes: 5000.5 },
      { min_seconds: 3601 },
      { nope: 1 },
    ]) {
      const r = cliRows.patchCliRows(user, { agents_resume_report: bad });
      expect(r.ok).toBe(false);
    }
    expect(user.agents).toMatchObject({ resume_first_line_max_bytes: 65536 });
  });

  it("a person's setting, never an agent's; never read as an agent id; config takes both", () => {
    expect(cliRows.PERSON_ONLY_SETTINGS).toContain("agents_resume_report");
    expect(AGENTS_RESERVED_KEYS).toEqual(
      expect.arrayContaining([
        "resume_first_line_max_bytes",
        "resume_report_min_seconds",
      ]),
    );
    expect(DOTTED["agents.resume_first_line_max_bytes"]).toEqual([
      "agents_resume_report",
      "first_line_max_bytes",
    ]);
    expect(DOTTED["agents.resume_report_min_seconds"]).toEqual([
      "agents_resume_report",
      "min_seconds",
    ]);
  });
});
