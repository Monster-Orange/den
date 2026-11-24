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
  runSettingChange,
  settingKind,
  undoSettingChange,
  type SettingChangeDeps,
} from "../../../src/ui/cli/setting-change.js";
import { notePolicyRun } from "../../../src/ui/server/approval-routes.js";
import type { DenConfig } from "../../../src/shared/den-config.js";
import {
  approvalsView,
  patchApprovals,
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

  it("the gate's settings are limits, routine on both modes (issue 1395)", () => {
    for (const mode of ["personal", "strict"] as const)
      for (const key of ["gate.max_slots", "gate.priority_agents"]) {
        const k = settingKind(key, mode);
        expect([mode, key, k.category, k.widens]).toEqual([
          mode,
          key,
          "limits",
          false,
        ]);
      }
  });

  it("strict: a browser run on the host (browser_requires_container 0) widens", () => {
    const k = "gate.browser_requires_container";
    expect(settingKind(k, "strict", 0).widens).toBe(true);
    expect(settingKind(k, "strict", false).widens).toBe(true);
    expect(settingKind(k, "strict", 1).widens).toBe(false);
    // With no value given, the key alone: a plain limit.
    expect(settingKind(k, "strict").widens).toBe(false);
    // Personal: every gate key stays routine, 0 included.
    expect(settingKind(k, "personal", 0).widens).toBe(false);
    // Another gate key at 0 is still a limit.
    expect(settingKind("gate.cpu_slots", "strict", 0).widens).toBe(false);
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

describe("every person-only setting has an ask path (Vision's ruling, issue 1391)", () => {
  it.each([
    ["agents.default_mode", "ask", true],
    ["server_agent.self_update", "auto", true],
    ["hub.allow_tools", false, true],
    ["hub.delivery_loop", false, false],
    ["hub.url", "https://hub.example.com", true],
    ["alerts.desktop", false, false],
    ["alerts.phone", true, false],
    ["alerts.quiet.from", "22:00", false],
    ["alerts.quiet.to", "07:00", false],
    ["editor_open", "zed", false],
    ["embed.origins", ["https://app.example.com"], true],
    ["embed.url_max_chars", 4000, false],
    ["web.machine_name", "laptop-2", false],
    ["shell.dock", true, false],
    ["shell.pins", ["den"], true],
  ] as [string, unknown, boolean][])(
    "%s can be asked for (widens: %s)",
    (key, value, widens) => {
      const c = ask(key, value);
      if (!c.ok) throw new Error(`${key}: ${c.error}`);
      expect([key, c.personOnly === true]).toEqual([key, widens]);
    },
  );

  it.each([
    ["agents.default_mode", "anything-goes"],
    ["server_agent.self_update", "always"],
    ["hub.allow_tools", "yes"],
    ["hub.url", "ftp://hub.example.com"],
    ["alerts.quiet.from", "25:99"],
    ["editor_open", "notepad"],
    ["embed.origins", ["not an origin"]],
    ["web.machine_name", "a b\nc"],
    ["shell.pins", "den"],
  ] as [string, unknown][])(
    "%s refuses what Settings refuses",
    (key, value) => {
      expect(ask(key, value).ok).toBe(false);
    },
  );

  it("a new Hub address drops the old token, as Settings does", () => {
    writeUser(
      "hub:\n  url: https://old.example.com\n  token: t0k\n  mcp_url: https://old.example.com/mcp\n",
    );
    const c = ask("hub.url", "https://new.example.com");
    if (!c.ok) throw new Error(c.error);
    expect(c.text).toMatch(/url: https:\/\/new\.example\.com/);
    expect(c.text).not.toMatch(/token|mcp_url/);
  });
});

describe("Settings › Approvals › Agents changing settings (issue 1371 Part 2)", () => {
  it("shows each category's choice in force, and whether the person set it", () => {
    const strict = approvalsView({ settings: { network: "auto" } }, "strict");
    expect(strict.settings.network).toEqual({ choice: "auto", set: true });
    expect(strict.settings.integrations).toEqual({ choice: "ask", set: false });
    const personal = approvalsView(undefined, "personal");
    expect(personal.settings.integrations).toEqual({
      choice: "auto",
      set: false,
    });
    expect(personal.settings.agent_powers).toEqual({
      choice: "ask",
      set: false,
    });
  });

  it("a row's change patches one category; null puts the default back", () => {
    const a = patchApprovals(
      { policy: "notify", settings: { look: "ask" } },
      { settings: { network: "never", look: null } },
    );
    if (!a.ok) throw new Error(a.error);
    expect(a.value).toEqual({
      policy: "notify",
      settings: { network: "never" },
    });
    const b = patchApprovals(a.value, { settings: { network: null } });
    if (!b.ok) throw new Error(b.error);
    expect(b.value).toEqual({ policy: "notify" });
  });

  it("refuses Change without asking for agent powers", () => {
    const a = patchApprovals(undefined, { settings: { agent_powers: "auto" } });
    expect(a.ok).toBe(false);
  });
});

describe("Undo, in the bell, of a setting changed without asking (issue 1371 Part 2)", () => {
  const read = () => fs.readFileSync(deps().userFile, "utf8");
  const ran = (key: string, value: unknown) => {
    const r = runSettingChange(deps(), { key, value, reason: "faster" });
    if (!r.ok) throw new Error(r.error);
    return { id: "ap-1", action: "setting_change", result: r };
  };

  it("puts the value before back, once", () => {
    writeUser("sessions:\n  close_grace_seconds: 30\n");
    const a = ran("sessions.close_grace_seconds", 45);
    expect(read()).toMatch(/close_grace_seconds: 45/);
    const u = undoSettingChange(deps(), a);
    if (!u.ok) throw new Error(u.error);
    expect(read()).toMatch(/close_grace_seconds: 30/);
    // A second Undo would lose nothing new, but is refused: it is done.
    expect(undoSettingChange(deps(), a).ok).toBe(false);
  });

  it("a key that was unset goes back to unset", () => {
    const a = ran("sessions.close_grace_seconds", 45);
    const u = undoSettingChange(deps(), a);
    if (!u.ok) throw new Error(u.error);
    expect(read()).not.toMatch(/close_grace_seconds/);
  });

  it("refuses when the key changed since, so nothing is lost", () => {
    const a = ran("sessions.close_grace_seconds", 45);
    ran("sessions.close_grace_seconds", 60);
    const u = undoSettingChange(deps(), a);
    expect(u.ok).toBe(false);
    if (!u.ok) expect(u.error).toMatch(/has changed since/);
    expect(read()).toMatch(/close_grace_seconds: 60/);
  });

  it("the person's Undo runs even where the category now says Never", () => {
    const a = ran("sessions.close_grace_seconds", 45);
    const text = read().replace(
      /^/,
      "approvals:\n  settings:\n    limits: never\n",
    );
    fs.writeFileSync(deps().userFile, text);
    expect(undoSettingChange(deps(), a).ok).toBe(true);
  });

  it("only a setting change that ran can be undone", () => {
    expect(
      undoSettingChange(deps(), {
        id: "x",
        action: "repo_clone",
        result: { ok: true },
      }).ok,
    ).toBe(false);
    expect(
      undoSettingChange(deps(), {
        id: "x",
        action: "setting_change",
        result: { ok: false, error: "no" },
      }).ok,
    ).toBe(false);
  });

  it("the bell row of a setting the policy ran carries Undo; other writes' don't", () => {
    const added: { undo?: { approval: string } }[] = [];
    const store = { add: (n: (typeof added)[number]) => (added.push(n), null) };
    notePolicyRun(
      store,
      {
        id: "ap-9",
        agent: "a1",
        summary: "s",
        action: "setting_change",
        result: { ok: true },
      },
      "p",
    );
    notePolicyRun(
      store,
      {
        id: "ap-8",
        agent: "a1",
        summary: "s",
        action: "repo_clone",
        result: { ok: true },
      },
      "p",
    );
    expect(added[0]!.undo).toEqual({ approval: "ap-9" });
    expect(added[1]!.undo).toBeUndefined();
  });
});

describe("install_mode through setting_change (issue 1391)", () => {
  const denStrict = (): SettingChangeDeps => ({
    ...deps(),
    denConfig: () => ({ install_mode: "strict" }) as unknown as DenConfig,
  });

  it("strict to personal is asked for (widens); to strict is routine", () => {
    writeUser("install_mode: strict\n");
    const loosen = ask("install_mode", "personal");
    if (!loosen.ok) throw new Error(loosen.error);
    expect(loosen.personOnly).toBe(true);
    writeUser("install_mode: personal\n");
    const tighten = ask("install_mode", "strict");
    if (!tighten.ok) throw new Error(tighten.error);
    expect(tighten.personOnly).toBeFalsy();
  });

  it("can't loosen a distribution's strict (den.yml)", () => {
    writeUser("install_mode: strict\n");
    for (const v of ["personal", null]) {
      const r = checkSettingChange(denStrict(), {
        key: "install_mode",
        value: v,
        reason: "test",
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/den\.yml sets install_mode: strict/);
    }
  });
});
