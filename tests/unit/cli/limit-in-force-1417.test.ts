/**
 * Issue 1417: one lookup gives each agent limit's value in force and where
 * it came from (user.yml, den.yml, or Den's default). `config <key>` reads
 * it (the value stays the last line of stdout, for scripts), and so does
 * the setting_change card's Now line, so the two can't drift.
 *
 * The writes go to a temp folder, never to a checkout's config/local.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  AGENTS_USER_LIMIT_KEYS,
  agentLimitInForce,
  type DenConfig,
  type UserConfig,
} from "../../../src/shared/den-config.js";
import { LOCK_WAIT_MINUTES_DEFAULT } from "../../../src/shared/agents/agent-lock.js";
import { TURN_READ_MAX_BYTES } from "../../../src/shared/agents/conversations.js";
import {
  checkSettingChange,
  runSettingChange,
  settingChangeKeys,
  type SettingChangeDeps,
} from "../../../src/ui/cli/setting-change.js";
import { settingChoice } from "../../../src/shared/approval-policy.js";

const user = (agents?: Record<string, unknown>) =>
  (agents ? { agents } : {}) as UserConfig;
const den = (agents?: Record<string, unknown>) =>
  (agents ? { agents } : {}) as unknown as DenConfig;

describe("the lookup: an agent limit's value in force, and its source", () => {
  it("unset anywhere: Den's default", () => {
    expect(agentLimitInForce("restart_wait_minutes", user(), den())).toEqual({
      value: 120,
      from: "default",
    });
  });

  it("den.yml only: den.yml's", () => {
    expect(
      agentLimitInForce(
        "restart_wait_minutes",
        user(),
        den({ restart_wait_minutes: 90 }),
      ),
    ).toEqual({ value: 90, from: "den.yml" });
  });

  it("both: user.yml's", () => {
    expect(
      agentLimitInForce(
        "restart_wait_minutes",
        user({ restart_wait_minutes: 100 }),
        den({ restart_wait_minutes: 90 }),
      ),
    ).toEqual({ value: 100, from: "user.yml" });
  });

  it("not an agent limit: undefined", () => {
    expect(agentLimitInForce("sandbox", user(), den())).toBeUndefined();
  });

  it.each([...AGENTS_USER_LIMIT_KEYS])("%s has a default, a number", (k) => {
    const r = agentLimitInForce(k, user(), den());
    expect(r?.from).toBe("default");
    expect(typeof r?.value).toBe("number");
  });

  it("the defaults are the readers' own (no second copy to drift)", () => {
    const d = (k: string) => agentLimitInForce(k, user(), den())?.value;
    expect(d("lock_wait_minutes")).toBe(LOCK_WAIT_MINUTES_DEFAULT);
    expect(Number(d("turn_read_max_mb")) * 1024 * 1024).toBe(
      TURN_READ_MAX_BYTES,
    );
    expect(d("max_concurrent")).toBe(4);
    expect(d("rotation_wait_minutes")).toBe(240);
    expect(d("token_peer_wait_ms")).toBe(30_000);
  });
});

describe("the setting_change card's Now line names the value it replaces", () => {
  let dir = "";
  let denCfg: DenConfig = den();
  const deps = (): SettingChangeDeps => ({
    userFile: path.join(dir, "config", "local", "user.yml"),
    backupDir: path.join(dir, "state", "settings-backups"),
    denConfig: () => denCfg,
    audit: () => undefined,
    now: () => "2026-11-24T08:00:00.000Z",
  });
  const writeUser = (t: string) => {
    fs.mkdirSync(path.dirname(deps().userFile), { recursive: true });
    fs.writeFileSync(deps().userFile, t);
  };
  const nowLine = (key: string, value: number) => {
    const r = checkSettingChange(deps(), { key, value, reason: "test" });
    if (!r.ok) throw new Error(r.error);
    return r.details.find((l) => /^Now: /.test(l));
  };
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "limit-1417-"));
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("an unset agent limit: Den's default, never 'not set'", () => {
    denCfg = den();
    writeUser("# mine\n");
    expect(nowLine("agents.max_concurrent", 5)).toBe("Now: 4 (Den's default)");
  });

  it("an unset terminal limit: Den's default too", () => {
    denCfg = den();
    writeUser("# mine\n");
    expect(nowLine("sessions.close_grace_seconds", 7)).toBe(
      "Now: 5 (Den's default)",
    );
  });

  it("den.yml sets it: den.yml's, so marked", () => {
    denCfg = den({ max_concurrent: 6 });
    writeUser("# mine\n");
    expect(nowLine("agents.max_concurrent", 5)).toBe("Now: 6 (from den.yml)");
  });

  it("user.yml sets it: the value, as before", () => {
    denCfg = den({ max_concurrent: 6 });
    writeUser("agents:\n  max_concurrent: 3\n");
    expect(nowLine("agents.max_concurrent", 5)).toBe("Now: 3");
  });

  it("not a limit: as before", () => {
    denCfg = den();
    writeUser("# mine\n");
    const r = checkSettingChange(deps(), {
      key: "editor",
      value: "vim",
      reason: "test",
    });
    if (!r.ok) throw new Error(r.error);
    expect(r.details.find((l) => /^Now: /.test(l))).toBe("Now: not set");
  });
});

describe("every agent limit has an agent ask path (issue 1417, Den Builder)", () => {
  let dir = "";
  const deps = (): SettingChangeDeps => ({
    userFile: path.join(dir, "config", "local", "user.yml"),
    backupDir: path.join(dir, "state", "settings-backups"),
    denConfig: () => den(),
    audit: () => undefined,
    now: () => "2026-11-24T08:00:00.000Z",
  });
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "limit-ask-1417-"));
    fs.mkdirSync(path.join(dir, "config", "local"), { recursive: true });
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("agents.restart_wait_minutes: a limit, routine on personal, Now in force, and written", () => {
    fs.writeFileSync(deps().userFile, "# mine\n");
    const c = checkSettingChange(deps(), {
      key: "agents.restart_wait_minutes",
      value: 121,
      reason: "test",
    });
    if (!c.ok) throw new Error(c.error);
    expect(c.category).toBe("limits");
    expect(c.personOnly).toBeUndefined();
    expect(c.details).toContain("Now: 120 (Den's default)");
    expect(settingChoice(c.category, "personal").choice).toBe("auto");
    const a = {
      id: "a1",
      action: "setting_change",
      agent: "g1",
      params: { key: "agents.restart_wait_minutes", value: 121, reason: "t" },
    };
    const r = runSettingChange(deps(), a.params);
    if (!r.ok) throw new Error(r.error);
    expect(fs.readFileSync(deps().userFile, "utf8")).toMatch(
      /restart_wait_minutes: 121/,
    );
  });

  it("a bad value is refused in den-config's words", () => {
    fs.writeFileSync(deps().userFile, "# mine\n");
    const c = checkSettingChange(deps(), {
      key: "agents.lock_wait_minutes",
      value: -3,
      reason: "test",
    });
    expect(c.ok).toBe(false);
  });

  it("the lookup and setting_change know the same agent limits", () => {
    const asked = settingChangeKeys()
      .filter((k) => /^agents\.[a-z_]+$/.test(k))
      .filter((k) => agentLimitInForce(k.slice(7), user(), den()));
    expect(asked.sort()).toEqual(
      AGENTS_USER_LIMIT_KEYS.map((k) => `agents.${k}`).sort(),
    );
  });
});

describe("the 2× rule holds for every agent limit (issue 1417, Builder 2)", () => {
  let dir = "";
  const deps = (): SettingChangeDeps => ({
    userFile: path.join(dir, "config", "local", "user.yml"),
    backupDir: path.join(dir, "state", "settings-backups"),
    denConfig: () => den(),
    audit: () => undefined,
    now: () => "2026-11-24T08:00:00.000Z",
  });
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "limit-2x-1417-"));
    fs.mkdirSync(path.join(dir, "config", "local"), { recursive: true });
    fs.writeFileSync(deps().userFile, "# mine\n");
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
  /** Whether an agent's change of key to value asks the person on personal. */
  const asks = (key: string, value: unknown) => {
    const c = checkSettingChange(deps(), { key, value, reason: "test" });
    if (!c.ok) throw new Error(c.error);
    return c.personOnly === true;
  };

  it.each([
    ["agents.turn_read_max_mb", 16, false],
    ["agents.turn_read_max_mb", 17, true],
    ["agents.turn_read_max_mb", 4096, true],
    ["agents.restart_wait_minutes", 240, false],
    ["agents.restart_wait_minutes", 241, true],
    ["agents.lock_wait_minutes", 60, false],
    ["agents.lock_wait_minutes", 61, true],
    ["agents.rotation_wait_minutes", 481, true],
    ["agents.token_peer_wait_ms", 60_001, true],
    ["agents.exited_shell_minutes", 20, false],
    ["agents.exited_shell_minutes", 21, true],
    // 0 is never reap: unlimited.
    ["agents.exited_shell_minutes", 0, true],
  ] as [string, number, boolean][])("%s to %s: asks %s", (key, value, ask) => {
    expect(asks(key, value)).toBe(ask);
  });

  it("lowering is routine for a wait or a size", () => {
    expect(asks("agents.turn_read_max_mb", 4)).toBe(false);
    expect(asks("agents.restart_wait_minutes", 30)).toBe(false);
  });

  it("unasked_exit_window_minutes is a guard: lowering it asks, raising it within 2× is routine", () => {
    expect(asks("agents.unasked_exit_window_minutes", 5)).toBe(true);
    expect(asks("agents.unasked_exit_window_minutes", 9)).toBe(true);
    // A tiny window lets a crash loop come back every time.
    expect(asks("agents.unasked_exit_window_minutes", 0.05)).toBe(true);
    expect(asks("agents.unasked_exit_window_minutes", 20)).toBe(false);
    expect(asks("agents.unasked_exit_window_minutes", 21)).toBe(true);
    // 0 is never brought back: the safest value.
    expect(asks("agents.unasked_exit_window_minutes", 0)).toBe(false);
  });

  it("unasked_exit_window_minutes put back to Den's default asks (the person's call)", () => {
    fs.writeFileSync(
      deps().userFile,
      "agents:\n  unasked_exit_window_minutes: 20\n",
    );
    expect(asks("agents.unasked_exit_window_minutes", null)).toBe(true);
  });

  it("unasked_exit_window_minutes from 0: any window asks", () => {
    fs.writeFileSync(
      deps().userFile,
      "agents:\n  unasked_exit_window_minutes: 0\n",
    );
    expect(asks("agents.unasked_exit_window_minutes", 5)).toBe(true);
    expect(asks("agents.unasked_exit_window_minutes", 0.05)).toBe(true);
  });

  it("lock_wait_minutes: lowering asks (a shorter wait takes over an unwritten lock sooner)", () => {
    expect(asks("agents.lock_wait_minutes", 0.001)).toBe(true);
    expect(asks("agents.lock_wait_minutes", 29)).toBe(true);
    expect(asks("agents.lock_wait_minutes", 30)).toBe(false);
  });

  it("a routine raise keeps its baseline: a second raise can't climb past 2× of the first", () => {
    const r = runSettingChange(
      deps(),
      { key: "agents.turn_read_max_mb", value: 16, reason: "t" },
      { agent: "g1", decidedBy: "auto:personal" },
    );
    if (!r.ok) throw new Error(r.error);
    expect(fs.readFileSync(deps().userFile, "utf8")).toMatch(
      /setting_baselines:[\s\S]*agents\.turn_read_max_mb: 8/,
    );
    expect(asks("agents.turn_read_max_mb", 17)).toBe(true);
  });
});
