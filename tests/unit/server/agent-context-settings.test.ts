/**
 * Issue 278: the limits are Settings with permissive defaults
 * (user.yml agent_context.*): POST /api/settings's `agent_context` and
 * `config agent_context.<key>` patch user.yml the same way, checking
 * each value; null clears one back to its default.
 */
import { describe, expect, it } from "@jest/globals";
import {
  PERSON_ONLY_SETTINGS,
  patchCliRows,
} from "../../../src/shared/settings-cli-rows.js";
import { configKeyNames } from "../../../src/ui/cli/config-command.js";
import { contextWatchSettings } from "../../../src/shared/agents/context-watch.js";

describe("issue 278: agent_context settings", () => {
  it("sets the numbers and the pause, read back by the watch", () => {
    const user: Record<string, unknown> = {};
    expect(
      patchCliRows(user, {
        agent_context: {
          compaction_loop_count: 5,
          compaction_loop_minutes: 20,
          pause_after_loop: true,
          instruction_share_percent: 25,
          context_tokens: 400_000,
        },
      }),
    ).toEqual({ ok: true });
    expect(contextWatchSettings(user.agent_context)).toEqual({
      loopCount: 5,
      loopMinutes: 20,
      pause: true,
      sharePercent: 25,
      contextTokens: 400_000,
    });
  });

  it("null clears back to the defaults; an empty block goes", () => {
    const user: Record<string, unknown> = {
      agent_context: { compaction_loop_count: 5, pause_after_loop: true },
    };
    expect(
      patchCliRows(user, {
        agent_context: { compaction_loop_count: null, pause_after_loop: null },
      }),
    ).toEqual({ ok: true });
    expect(user).toEqual({});
  });

  it("a wrong value changes nothing and says why", () => {
    const user: Record<string, unknown> = {};
    for (const bad of [
      { compaction_loop_count: 0 },
      { compaction_loop_minutes: 2.5 },
      { pause_after_loop: "yes" },
      { instruction_share_percent: 101 },
      { context_tokens: 10 },
      { nope: 1 },
    ]) {
      const r = patchCliRows(user, { agent_context: bad });
      expect(r.ok).toBe(false);
    }
    expect(user).toEqual({});
  });

  it("a person's to change, and each is a config key", () => {
    expect(PERSON_ONLY_SETTINGS).toContain("agent_context");
    expect(configKeyNames()).toEqual(
      expect.arrayContaining([
        "agent_context.compaction_loop_count",
        "agent_context.compaction_loop_minutes",
        "agent_context.pause_after_loop",
        "agent_context.instruction_share_percent",
        "agent_context.context_tokens",
      ]),
    );
  });
});
