/**
 * Issue 110, Coach Apply slice 2 (mock in Hub, Den project: "Coach Apply:
 * a finding's change waits for a person's Allow"):
 *   - a finding's proposal says its change and how to undo it, in words;
 *   - Den keeps which held write a finding's Apply asked for
 *     (coach/applies.json, 0600), so a row follows its held write;
 *   - the held write's state reads as the row's: waiting, applied,
 *     denied or failed.
 */
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  applyLinkOf,
  applyViewOf,
  applyStateOf,
  linkApply,
  readApplyLinks,
} from "../../../src/shared/coach/applies.js";
import { coachFindings } from "../../../src/shared/coach/findings.js";
import { FINDING_DEFAULTS } from "../../../src/shared/coach/settings.js";

let dir = "";
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-coach-apply-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("a proposal says its change and how to undo it", () => {
  it("subagents on Opus: set the persona's subagent model to Sonnet; set it back there", () => {
    const report = {
      version: 1,
      ranAt: "2026-11-22T17:14:00.000Z",
      window: {
        from: "2026-11-15T12:00:00.000Z",
        to: "2026-11-22T12:00:00.000Z",
        days: 7,
      },
      agents: [
        {
          agent: "builder",
          workspace: "shop",
          persona: "builder",
          runtime: "den-claude",
          metrics: {
            subagent_opus_pct: 87,
            calls: 100,
            compactions: 0,
            polls: 0,
            denials: 0,
            prompts: 10,
          },
          models: { main: {}, subagent: { "claude-opus-5-5": 140 } },
          perDay: {},
        },
      ],
    };
    const [f] = coachFindings(report as never, FINDING_DEFAULTS).filter(
      (x) => x.kind === "subagent_opus",
    );
    expect(f.apply).toMatchObject({
      action: "persona_update",
      args: { id: "builder", project: "shop", subagentModel: "sonnet" },
      change: "Set builder's subagent model to Sonnet.",
      reversible: "Set it back in builder's persona.",
    });
  });
});

describe("which held write a finding's Apply asked for", () => {
  it("none yet: no link", () => {
    expect(readApplyLinks(dir)).toEqual({});
    expect(applyLinkOf(dir, "subagent_opus:builder")).toBeNull();
  });

  it("kept per finding, the newest Apply's; the file is the owner's only", () => {
    linkApply(dir, "subagent_opus:builder", "a1", "2026-11-22T18:00:00.000Z");
    linkApply(dir, "subagent_opus:builder", "a2", "2026-11-22T19:00:00.000Z");
    expect(applyLinkOf(dir, "subagent_opus:builder")).toEqual({
      approval: "a2",
      at: "2026-11-22T19:00:00.000Z",
    });
    const file = path.join(dir, "coach", "applies.json");
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it("a __proto__ key in the file never sets a prototype", () => {
    fs.mkdirSync(path.join(dir, "coach"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "coach", "applies.json"),
      '{"__proto__":{"approval":"x","at":"y"},"constructor":{"approval":"x","at":"y"},"subagent_opus:b":{"approval":"a1","at":"t"}}',
    );
    const links = readApplyLinks(dir);
    expect(Object.getPrototypeOf(links)).not.toEqual({
      approval: "x",
      at: "y",
    });
    expect(Object.keys(links)).toEqual(["subagent_opus:b"]);
    expect(applyLinkOf(dir, "__proto__")).toBeNull();
    expect(applyLinkOf(dir, "constructor")).toBeNull();
  });
  it("a hand-broken file reads as no links", () => {
    fs.mkdirSync(path.join(dir, "coach"), { recursive: true });
    fs.writeFileSync(path.join(dir, "coach", "applies.json"), "{nope");
    expect(readApplyLinks(dir)).toEqual({});
  });
});

describe("the row's state follows its held write", () => {
  it("pending or running: waiting", () => {
    expect(applyStateOf({ state: "pending" })).toBe("waiting");
    expect(applyStateOf({ state: "running" })).toBe("waiting");
  });
  it("done: applied, unless its run failed", () => {
    expect(applyStateOf({ state: "done", result: { ok: true } })).toBe(
      "applied",
    );
    expect(applyStateOf({ state: "done", result: { ok: false } })).toBe(
      "failed",
    );
  });
  it("denied, expired or taken back: denied (nobody allowed it)", () => {
    for (const s of ["denied", "expired", "withdrawn"] as const)
      expect(applyStateOf({ state: s })).toBe("denied");
  });
  it("lost, or a held write Den no longer knows: failed", () => {
    expect(applyStateOf({ state: "lost" })).toBe("failed");
    expect(applyStateOf(null)).toBe("failed");
  });
});

describe("what the row's line says once decided (mock v3)", () => {
  const at = Date.parse("2026-11-23T00:02:00.000Z");
  it("waiting: the state only", () => {
    expect(applyViewOf({ state: "pending" }, "Pat")).toEqual({
      state: "waiting",
    });
  });
  it("applied: who allowed it (the owner's name) and when", () => {
    expect(
      applyViewOf(
        { state: "done", decidedBy: "s1", decidedAt: at, result: { ok: true } },
        "Pat",
      ),
    ).toEqual({
      state: "applied",
      decidedAt: "2026-11-23T00:02:00.000Z",
      by: "Pat",
    });
  });
  it("no name known, or decided by Den itself: no name", () => {
    expect(
      applyViewOf({ state: "denied", decidedBy: "s1", decidedAt: at }),
    ).toEqual({ state: "denied", decidedAt: "2026-11-23T00:02:00.000Z" });
    expect(
      applyViewOf(
        { state: "denied", decidedBy: "auto:x", decidedAt: at },
        "Pat",
      ).by,
    ).toBeUndefined();
  });
  it("failed: the run's reason, with secrets taken out and kept short", () => {
    const v = applyViewOf(
      {
        state: "done",
        decidedBy: "s1",
        decidedAt: at,
        result: {
          ok: false,
          error: `persona file is locked; token ghp_${"a".repeat(36)} ${"x".repeat(400)}`,
        },
      },
      "Pat",
    );
    expect(v.state).toBe("failed");
    expect(v.reason).toMatch(/^persona file is locked/);
    expect(v.reason).not.toMatch(/ghp_a{36}/);
    expect(v.reason!.length).toBeLessThanOrEqual(200);
  });
  it("a held write Den no longer knows: failed, with no reason", () => {
    expect(applyViewOf(null, "Pat")).toEqual({ state: "failed" });
  });
});
