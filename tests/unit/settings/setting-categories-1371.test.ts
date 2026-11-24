/**
 * Issue 1371 Part 2, with issue 1391: every setting an agent may ask to
 * change has a category; the person chooses per category whether an
 * agent's change runs without asking (and tells them), asks, or is
 * refused. Agent powers only ask or are refused. The defaults follow the
 * install's mode: on a personal install editors, terminals and runtimes
 * change at once; network and agent powers still ask.
 *
 * The writes go to a temp folder, never to a checkout's config/local.
 */
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  checkSettingChange,
  settingKind,
  type SettingChangeDeps,
} from "../../../src/ui/cli/setting-change.js";
import type { DenConfig } from "../../../src/shared/den-config.js";
import {
  policyFor,
  readPolicySetting,
  settingChoice,
} from "../../../src/shared/approval-policy.js";

let dir = "";

function deps(): SettingChangeDeps {
  return {
    userFile: path.join(dir, "config", "local", "user.yml"),
    backupDir: path.join(dir, "state", "settings-backups"),
    denConfig: () => ({}) as DenConfig,
    audit: () => undefined,
    now: () => "2026-11-24T08:00:00.000Z",
  };
}

function writeUser(text: string): void {
  const f = deps().userFile;
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "setting-cat-"));
  writeUser("# mine\n");
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const ask = (key: string, value: unknown) =>
  checkSettingChange(deps(), { key, value, reason: "test" });

describe("every key has a category and a severity (issue 1371 Part 2)", () => {
  it.each([
    ["agents.max_concurrent", "limits", "low"],
    ["sessions.close_grace_seconds", "limits", "low"],
    ["cli_tabs", "look", "low"],
    ["github.watch_interval_seconds", "integrations", "medium"],
    ["hub.groups_cache_seconds", "integrations", "medium"],
    ["editor", "integrations", "medium"],
    ["web.address_check_timeout_seconds", "network", "high"],
    ["web.bridge_listen", "network", "high"],
    ["agents.sandbox", "agent_powers", "high"],
    ["approvals.policy", "agent_powers", "high"],
    ["mcp.actions", "agent_powers", "high"],
    ["install_mode", "agent_powers", "high"],
  ])("%s is %s (%s)", (key, category, severity) => {
    const k = settingKind(key);
    expect([k.category, k.severity]).toEqual([category, severity]);
  });

  it("agent powers always widen, on both modes", () => {
    for (const mode of ["personal", "strict"] as const)
      for (const key of ["agents.sandbox", "approvals.policy", "install_mode"])
        expect([mode, key, settingKind(key, mode).widens]).toEqual([
          mode,
          key,
          true,
        ]);
  });

  it("editors, terminals and runtimes are routine only on a personal install", () => {
    for (const key of ["editor", "terminal", "editor_overrides.typescript"]) {
      expect([key, settingKind(key, "strict").widens]).toEqual([key, true]);
      expect([key, settingKind(key, "personal").widens]).toEqual([key, false]);
    }
    expect(
      settingKind("agents.runtimes.den-claude.bin", "personal").widens,
    ).toBe(false);
    expect(settingKind("agents.runtimes.den-claude.bin", "strict").widens).toBe(
      true,
    );
  });
});

describe("the person's choice per category (issue 1371 Part 2)", () => {
  const change = (category: Parameters<typeof settingChoice>[0], o = {}) =>
    policyFor("setting_change", { setting: { category }, ...o }).kind;

  it("strict defaults: limits and look tell, the rest ask", () => {
    expect(change("limits")).toBe("notify");
    expect(change("look")).toBe("notify");
    expect(change("integrations")).toBe("ask");
    expect(change("network")).toBe("ask");
    expect(change("agent_powers")).toBe("ask");
  });

  it("personal defaults: integrations tell too; network and agent powers ask", () => {
    const p = { mode: "personal" as const };
    expect(change("limits", p)).toBe("notify");
    expect(change("integrations", p)).toBe("notify");
    expect(change("network", p)).toBe("ask");
    expect(change("agent_powers", p)).toBe("ask");
  });

  it("the person's choice wins over the default", () => {
    const install = readPolicySetting({
      settings: { network: "auto", limits: "ask" },
    });
    expect(change("network", { install })).toBe("notify");
    expect(change("limits", { install })).toBe("ask");
  });

  it("a widening key asks whatever the choice", () => {
    const install = readPolicySetting({ settings: { network: "auto" } });
    expect(
      policyFor("setting_change", {
        widens: true,
        mode: "personal",
        install,
        setting: { category: "network" },
      }).kind,
    ).toBe("ask");
  });

  it("agent powers offer only ask or never; a bad category is named", () => {
    expect(() =>
      readPolicySetting({ settings: { agent_powers: "auto" } }),
    ).toThrow(/approvals\.settings\.agent_powers: ask, never/);
    expect(() => readPolicySetting({ settings: { colour: "ask" } })).toThrow(
      /"colour" is not a category/,
    );
    expect(() =>
      readPolicySetting({ settings: { limits: "sometimes" } }),
    ).toThrow(/approvals\.settings\.limits: auto, ask, never/);
  });
});

describe("setting_change follows the choice (issue 1371 Part 2)", () => {
  it("names its category on the check, for the policy", () => {
    const c = ask("sessions.close_grace_seconds", 45);
    if (!c.ok) throw new Error(c.error);
    expect(c.category).toBe("limits");
  });

  it("Never refuses, and names the Settings row that changes it", () => {
    writeUser("approvals:\n  settings:\n    limits: never\n");
    const c = ask("sessions.close_grace_seconds", 45);
    expect(c.ok).toBe(false);
    if (c.ok) return;
    expect(c.error).toMatch(/Settings › Approvals › Agents changing settings/);
    expect(c.error).toMatch(/Never/);
  });

  it("the mode is read from user.yml: personal by default", () => {
    const c = ask("editor", "vim");
    if (!c.ok) throw new Error(c.error);
    expect(c.personOnly).toBeUndefined();
    writeUser("install_mode: strict\n");
    const s = ask("editor", "vim");
    if (!s.ok) throw new Error(s.error);
    expect(s.personOnly).toBe(true);
  });
});

describe("routine programs are checked as Settings checks them (issue 1391)", () => {
  it("an editor or terminal Den doesn't know is refused", () => {
    for (const [key, v] of [
      ["editor", "sh -c 'curl x | sh'"],
      ["terminal", "not-a-terminal"],
      ["editor_overrides.typescript", "rm"],
    ] as const) {
      const c = ask(key, v);
      expect([key, c.ok]).toEqual([key, false]);
    }
    expect(ask("editor_overrides.klingon", "vim").ok).toBe(false);
  });

  it("a known one is taken", () => {
    expect(ask("editor", "vim").ok).toBe(true);
    expect(ask("editor_overrides.typescript", "vim").ok).toBe(true);
  });

  it("a runtime's bin must be an absolute path to a program", () => {
    expect(ask("agents.runtimes.den-claude.bin", "claude").ok).toBe(false);
    expect(ask("agents.runtimes.den-claude.bin", "/bin/sh").ok).toBe(true);
    expect(
      ask("agents.runtimes.den-claude.bin", path.join(dir, "missing")).ok,
    ).toBe(false);
  });
});

describe("secrets: a reference may be asked for, never a value (issue 1391)", () => {
  it("a token source or a ref is a held ask on the person's own Allow", () => {
    for (const [key, v] of [
      ["secrets.onepassword.token", "env:OP_SERVICE_ACCOUNT_TOKEN"],
      ["secrets.onepassword.token", "file:/Users/me/.op-token"],
      ["secrets.provider", "1password"],
      [
        "secrets.refs.sudo",
        { vault: "Private", item: "Dev Keys", field: "PWD" },
      ],
      ["secrets.keys", { "Private/Dev Keys/PWD": "LOCAL_PWD" }],
    ] as const) {
      const c = ask(key, v);
      if (!c.ok) throw new Error(`${key}: ${c.error}`);
      expect([key, c.personOnly, c.category]).toEqual([
        key,
        true,
        "agent_powers",
      ]);
    }
  });

  it("a raw secret is refused, without showing it, with a hint", () => {
    const c = ask("secrets.onepassword.token", "ops_eyJzaWduSW5BZGRyZXNz");
    expect(c.ok).toBe(false);
    if (c.ok) return;
    expect(c.error).toMatch(/did you mean a reference/);
    expect(c.error).not.toMatch(/ops_eyJ/);
  });
});
