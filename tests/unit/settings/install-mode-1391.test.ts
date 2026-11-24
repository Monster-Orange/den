/**
 * Issue 1391: an install is personal (one person, their own machine; the
 * default) or strict (opt-in, today's behaviour). Personal: the agent
 * sandbox is off unless set, Doctor and the bell don't ask to turn it on,
 * and held writes ask only for money, deletes, real security and acting on
 * others. An explicit value always wins.
 */

import { describe, expect, it } from "@jest/globals";
import {
  readAgentsConfig,
  readInstallMode,
  resolveInstallMode,
  type DenConfig,
  type UserConfig,
} from "../../../src/shared/den-config.js";
import { legacyAgentIds } from "../../../src/shared/agents/sandbox-rollout.js";
import { sandboxLines } from "../../../src/ui/cli/agents-command.js";
import { settingKind } from "../../../src/ui/cli/setting-change.js";
import {
  criticalWhy,
  policyFor,
  HELD_WRITE_RISK,
} from "../../../src/shared/approval-policy.js";

const agents = (u: UserConfig) => readAgentsConfig({} as DenConfig, u);

describe("install mode (issue 1391)", () => {
  it("is personal when nothing is set, strict only when asked", () => {
    expect(readInstallMode({})).toBe("personal");
    expect(readInstallMode({ install_mode: "personal" })).toBe("personal");
    expect(readInstallMode({ install_mode: "strict" })).toBe("strict");
  });

  it("fails closed: null, a typo or any other value is strict", () => {
    for (const v of [null, "open", "Personal", "", 3, true, ["personal"]])
      expect([v, readInstallMode({ install_mode: v })]).toEqual([v, "strict"]);
  });
});

describe("den.yml and user.yml: strict in either wins (issue 1391)", () => {
  const den = (v: unknown) => ({ install_mode: v }) as Partial<DenConfig>;

  it("both unset: personal, Den's default", () => {
    expect(resolveInstallMode({}, {})).toEqual({
      mode: "personal",
      from: "default",
    });
    expect(readInstallMode({})).toBe("personal");
  });

  it("den.yml strict, user.yml personal: strict, from den.yml", () => {
    expect(
      resolveInstallMode({ install_mode: "personal" }, den("strict")),
    ).toEqual({ mode: "strict", from: "den.yml" });
  });

  it("user.yml strict: strict, from user.yml (den.yml unset or personal)", () => {
    expect(resolveInstallMode({ install_mode: "strict" }, {})).toEqual({
      mode: "strict",
      from: "user.yml",
    });
    expect(
      resolveInstallMode({ install_mode: "strict" }, den("personal")),
    ).toEqual({ mode: "strict", from: "user.yml" });
  });

  it("den.yml sets the default; user.yml unset keeps it", () => {
    expect(resolveInstallMode({}, den("personal"))).toEqual({
      mode: "personal",
      from: "den.yml",
    });
    expect(resolveInstallMode({}, den("strict"))).toEqual({
      mode: "strict",
      from: "den.yml",
    });
  });

  it("a bad value in den.yml is strict too", () => {
    expect(
      resolveInstallMode({ install_mode: "personal" }, den("opne")),
    ).toEqual({ mode: "strict", from: "den.yml" });
  });

  it("the agent sandbox follows den.yml's strict over user.yml's personal", () => {
    const a = readAgentsConfig(
      { install_mode: "strict" } as unknown as DenConfig,
      { install_mode: "personal" },
    );
    expect(a.mode).toBe("strict");
    expect(a.sandbox).toBe(true);
  });
});

describe("changing install_mode (issue 1391)", () => {
  it("strict to personal widens: the person's Allow", () => {
    expect(settingKind("install_mode", "strict", "personal").widens).toBe(true);
    // Back to Den's default (personal, unless den.yml says strict).
    expect(settingKind("install_mode", "strict", null).widens).toBe(true);
  });

  it("to strict is routine, on either mode", () => {
    expect(settingKind("install_mode", "personal", "strict").widens).toBe(
      false,
    );
    expect(settingKind("install_mode", "strict", "strict").widens).toBe(false);
  });

  it("with no value given, the key alone widens", () => {
    expect(settingKind("install_mode", "strict").widens).toBe(true);
  });
});

describe("the agent sandbox's default follows the mode (issue 1391)", () => {
  it("a new install with no mode set: the sandbox is off", () => {
    const a = agents({});
    expect(a.mode).toBe("personal");
    expect(a.sandbox).toBe(false);
    expect(a.sandboxRequired).toBeFalsy();
  });

  it("strict keeps today's default: on", () => {
    expect(agents({ install_mode: "strict" }).sandbox).toBe(true);
  });

  it("an explicit agents.sandbox: on survives the upgrade to personal", () => {
    expect(agents({ agents: { sandbox: "on" } } as UserConfig).sandbox).toBe(
      true,
    );
    const req = agents({ agents: { sandbox: "required" } } as UserConfig);
    expect(req.sandbox).toBe(true);
    expect(req.sandboxRequired).toBe(true);
  });

  it("an explicit off stays off on strict too", () => {
    expect(
      agents({
        install_mode: "strict",
        agents: { sandbox: "off" },
      } as UserConfig).sandbox,
    ).toBe(false);
  });

  it("one agent's own sandbox: on still wins over the personal default", () => {
    const a = agents({ agents: { a1: { sandbox: "on" } } } as UserConfig);
    expect(a.sandbox).toBe(false);
    expect(a.agents?.a1?.sandbox).toBe(true);
  });
});

describe("no sandbox nags on a personal install (issue 1391)", () => {
  it("no agent counts as from before the sandbox when it is off for all", () => {
    const recs = [
      { id: "old" },
      { id: "older", sandbox: { applied: false, legacy: true } },
    ];
    expect(legacyAgentIds(recs, { sandbox: false })).toEqual([]);
    // Strict, on: the rollout still counts the agents from before it.
    expect(legacyAgentIds(recs, {})).toEqual(["old", "older"]);
  });

  it("Doctor says the mode once, and warns about no agent outside it", () => {
    const text = sandboxLines({
      here: { applied: false, reason: "off on this personal install" },
      outside: [{ id: "a1", project: "p", reason: "the sandbox is off" }],
      fromBefore: 0,
      personalOff: true,
    }).join("\n");
    expect(text).not.toMatch(/Sandbox is off for/);
    expect(text).not.toMatch(/Turn on/);
    expect(text).not.toMatch(/⚠/);
    expect(text.match(/personal install/g)).toHaveLength(1);
    expect(text).toMatch(/install_mode: strict/);
  });

  it("Doctor says which file set the mode", () => {
    const line = (from: "den.yml" | "user.yml" | "default") =>
      sandboxLines({
        here: { applied: true },
        outside: [],
        fromBefore: 0,
        mode: "strict",
        modeFrom: from,
      }).join("\n");
    expect(line("den.yml")).toMatch(/strict install .*set in den\.yml/);
    expect(line("user.yml")).toMatch(/set in config\/local\/user\.yml/);
  });

  it("strict, or an explicit on, still warns as today", () => {
    const text = sandboxLines({
      here: { applied: false, reason: "no sandbox" },
      outside: [{ id: "a1", project: "p", reason: "no sandbox here" }],
      fromBefore: 2,
    }).join("\n");
    expect(text).toMatch(/⚠ Sandbox is off for 2 agents/);
    expect(text).toMatch(/⚠ a1 \(p\) runs outside it/);
  });
});

describe("held writes on a personal install (issue 1391)", () => {
  const personal = { mode: "personal" as const };

  it("a write that widens agents' reach runs at once and tells the person", () => {
    for (const w of ["project_mode", "agent_mode", "agent_create", "repo_add"])
      expect([w, policyFor(w, { widens: true, ...personal }).kind]).toEqual([
        w,
        "notify",
      ]);
    // A write whose own kind is ask (hub_link) follows the policy too.
    expect(policyFor("hub_link", personal).kind).toBe("notify");
  });

  it("real security, money, deletes and acting on others still ask", () => {
    for (const w of [
      "agent_sandbox_set", // the sandbox
      "approval_policy", // approvals
      "web_url_set", // exposure
      "hub_connect", // where agents publish
      "embed_key_create", // a credential
      "test_person_setup", // who may sign in
      "gate_runner_token_create", // a secret (its area)
      "report", // acting on others (public)
      "verify_run", // a shared environment
      "setting_change", // a setting that widens
    ])
      expect([w, policyFor(w, { widens: true, ...personal }).kind]).toEqual([
        w,
        "ask",
      ]);
    expect(policyFor("refund_payment", personal).kind).toBe("ask");
    expect(policyFor("drop_backups", personal).kind).toBe("ask");
  });

  it("a write no one has placed still asks (fails closed)", () => {
    expect(policyFor("brand_new_write", personal).kind).toBe("ask");
    expect(criticalWhy("brand_new_write", false, [], "personal")).toBe(
      "critical",
    );
  });

  it("every write that stays asking on personal is named in the table", () => {
    const kept = Object.entries(HELD_WRITE_RISK)
      .filter(([, v]) => v.personal === "keep")
      .map(([k]) => k)
      .sort();
    expect(kept).toEqual(
      [
        "agent_sandbox_set",
        "approval_policy",
        "den_update",
        "embed_key_create",
        "embed_key_revoke",
        "hub_connect",
        "project_mcp_add",
        "project_mcp_update",
        "report",
        "setting_change",
        "test_person_setup",
        "verify_run",
        "web_url_set",
      ].sort(),
    );
  });

  it("strict keeps today's held asks", () => {
    expect(policyFor("project_mode", { widens: true }).kind).toBe("ask");
    expect(
      policyFor("project_mode", { widens: true, mode: "strict" }).kind,
    ).toBe("ask");
    expect(policyFor("hub_link", { mode: "strict" }).kind).toBe("ask");
    expect(criticalWhy("repo_add", false, [], "strict")).toBe("critical");
  });
});
