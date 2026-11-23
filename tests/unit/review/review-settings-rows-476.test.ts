/**
 * Issue 476: Settings › Agents › Reviews and the usage caps are written
 * through POST /api/settings and `config` (patchCliRows), and are a
 * person's only: an agent can never turn reviews on, widen its own limits
 * or let agents approve.
 */
import { describe, expect, it } from "@jest/globals";
import {
  PERSON_ONLY_SETTINGS,
  patchCliRows,
} from "../../../src/shared/settings-cli-rows.js";

describe("reviews and usage Settings", () => {
  it("are a person's only", () => {
    expect(PERSON_ONLY_SETTINGS).toContain("reviews");
    expect(PERSON_ONLY_SETTINGS).toContain("usage");
  });

  it("saves the reviewer, its limits and the switches", () => {
    const user: Record<string, unknown> = {};
    expect(
      patchCliRows(user, {
        reviews: {
          enabled: true,
          min_session_left_pct: 25,
          claim_window_seconds: 20,
          agents_may_approve: false,
          install_label: "den-1",
          base_deny: ["main", "release/*"],
          reviewer: {
            agent: "den-reviewer",
            repos: ["octo/app"],
            skill: "deep-review:deep-review",
            skill_args: "--depth standard",
          },
        },
        usage: { session_token_cap: 2_000_000, weekly_token_cap: 0 },
      }),
    ).toEqual({ ok: true });
    expect(user.reviews).toEqual({
      enabled: true,
      min_session_left_pct: 25,
      claim_window_seconds: 20,
      agents_may_approve: false,
      install_label: "den-1",
      base_deny: ["main", "release/*"],
      reviewer: {
        agent: "den-reviewer",
        repos: ["octo/app"],
        skill: "deep-review:deep-review",
        skill_args: "--depth standard",
      },
    });
    expect(user.usage).toEqual({
      session_token_cap: 2_000_000,
      weekly_token_cap: 0,
    });
  });

  it("null removes a key; the block goes when empty", () => {
    const user: Record<string, unknown> = {
      reviews: { enabled: true, max_rounds: 5 },
    };
    expect(patchCliRows(user, { reviews: { max_rounds: null } })).toEqual({
      ok: true,
    });
    expect(user.reviews).toEqual({ enabled: true });
    expect(patchCliRows(user, { reviews: { enabled: null } })).toEqual({
      ok: true,
    });
    expect(user.reviews).toBeUndefined();
  });

  it("refuses a bad value, naming the key, and changes nothing", () => {
    const bad: Record<string, unknown>[] = [
      { reviews: { min_session_left_pct: 101 } },
      { reviews: { enabled: "yes" } },
      { reviews: { nope: 1 } },
      { reviews: { reviewer: { agent: "r", repos: ["not a repo"] } } },
      { reviews: { reviewer: { agent: "r -->", repos: ["o/r"] } } },
      { reviews: { install_label: "has spaces" } },
      { usage: { session_token_cap: -1 } },
      { usage: { other: 1 } },
    ];
    for (const b of bad) {
      const user: Record<string, unknown> = {};
      const r = patchCliRows(user, b);
      expect(r.ok).toBe(false);
      expect((r as { error: string }).error).toMatch(/^(reviews|usage)/);
      expect(user).toEqual({});
    }
  });
});
