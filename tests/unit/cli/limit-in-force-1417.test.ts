/**
 * Issue 1417: one lookup gives each agent limit's value in force and where
 * it came from (user.yml, den.yml, or Den's default). `config <key>` reads
 * it (the value stays the last line of stdout, for scripts), and so does
 * the setting_change card's Now line, so the two can't drift.
 *
 * The writes go to a temp folder, never to a checkout's config/local.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
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
  type SettingChangeDeps,
} from "../../../src/ui/cli/setting-change.js";

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
