/**
 * Issue 1373: the agents' limits (agents.max_concurrent and the other
 * AGENTS_USER_LIMIT_KEYS) set in user.yml win over the distribution's
 * den.yml, key by key, as issue 532 did for sessions.*. Settings and
 * `config` write them to user.yml, checked with den-config's own words.
 * Keys that widen what an agent may do are never taken from user.yml's
 * agents block here. Invented names only.
 */
import { afterAll, beforeAll, describe, expect, it, jest } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as yaml from "yaml";

type DenConfigMod = typeof import("../../../src/shared/den-config.js");
type RowsMod = typeof import("../../../src/shared/settings-cli-rows.js");
type ConfigCmd = typeof import("../../../src/ui/cli/config-command.js");

let root = "";
const savedRoot = process.env.DEN_ROOT;
let cfg: DenConfigMod;
let rows: RowsMod;
let cli: ConfigCmd;

const userYml = () => path.join(root, "config", "local", "user.yml");
const writeUser = (s: string) => fs.writeFileSync(userYml(), s);
const readUser = () =>
  (yaml.parse(fs.readFileSync(userYml(), "utf8")) ?? {}) as Record<
    string,
    unknown
  >;
const DEN_YML = [
  "environments: [local]",
  "agents:",
  "  max_concurrent: 8",
  "  lock_wait_minutes: 3",
  "  token_binding: true",
  "",
].join("\n");

beforeAll(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-1373-")));
  fs.mkdirSync(path.join(root, "config", "local"), { recursive: true });
  fs.writeFileSync(path.join(root, "den.yml"), "product:\n  name: den\n");
  fs.writeFileSync(path.join(root, "config", "den.yml"), DEN_YML);
  process.env.DEN_ROOT = root;
  cfg = await import("../../../src/shared/den-config.js");
  rows = await import("../../../src/shared/settings-cli-rows.js");
  cli = await import("../../../src/ui/cli/config-command.js");
});
afterAll(() => {
  if (savedRoot === undefined) delete process.env.DEN_ROOT;
  else process.env.DEN_ROOT = savedRoot;
  fs.rmSync(root, { recursive: true, force: true });
});
const clear = () => fs.rmSync(userYml(), { force: true });

describe("issue 1373: user.yml's agent limits win", () => {
  it("the limit keys are named once, max_concurrent among them; no widening key", () => {
    expect(cfg.AGENTS_USER_LIMIT_KEYS).toContain("max_concurrent");
    for (const k of cfg.AGENTS_USER_LIMIT_KEYS)
      expect(cfg.AGENTS_RESERVED_KEYS).toContain(k);
    for (const widen of [
      "token_binding",
      "files",
      "issue_writes",
      "api_only_engines",
      "persona_packs",
      "helpers",
      "subagents",
      "claude_ai_connectors",
      "sandbox",
      "sandbox_sockets",
    ])
      expect(cfg.AGENTS_USER_LIMIT_KEYS).not.toContain(widen);
  });

  it("Settings and config set max_concurrent; the other limits are user.yml's by hand", () => {
    expect([...cfg.AGENTS_SETTINGS_KEYS]).toEqual(["max_concurrent"]);
    for (const k of cfg.AGENTS_SETTINGS_KEYS)
      expect(cfg.AGENTS_USER_LIMIT_KEYS).toContain(k);
    expect(cli.configKeyNames()).toContain("agents.max_concurrent");
  });

  it("with only user.yml set, the cap follows it", () => {
    fs.writeFileSync(
      path.join(root, "config", "den.yml"),
      "environments: [local]\n",
    );
    try {
      writeUser("agents:\n  max_concurrent: 14\n");
      expect(cfg.readAgentsConfig().maxConcurrent).toBe(14);
    } finally {
      fs.writeFileSync(path.join(root, "config", "den.yml"), DEN_YML);
      clear();
    }
  });

  it("with both set, user.yml wins; den.yml's other keys stand", () => {
    writeUser("agents:\n  max_concurrent: 14\n");
    try {
      const a = cfg.readAgentsConfig();
      expect(a.maxConcurrent).toBe(14);
      expect(a.lockWaitMs).toBe(3 * 60_000);
    } finally {
      clear();
    }
    expect(cfg.readAgentsConfig().maxConcurrent).toBe(8);
  });

  it("every limit key in user.yml wins over den.yml's", () => {
    writeUser("agents:\n  lock_wait_minutes: 9\n");
    try {
      expect(cfg.readAgentsConfig().lockWaitMs).toBe(9 * 60_000);
    } finally {
      clear();
    }
  });

  it("a widening key in user.yml's agents block is not taken from there", () => {
    writeUser("agents:\n  token_binding: false\n");
    try {
      expect(cfg.readAgentsConfig().tokenBinding).toBe(true);
    } finally {
      clear();
    }
  });

  it("a bad value in user.yml is an error naming user.yml", () => {
    writeUser("agents:\n  max_concurrent: 0\n");
    try {
      expect(() => cfg.readAgentsConfig()).toThrow(/user\.yml/);
      expect(() => cfg.readAgentsConfig()).toThrow(/agents\.max_concurrent/);
    } finally {
      clear();
    }
  });

  it("the drift: what user.yml sets that den.yml sets differently", () => {
    writeUser("agents:\n  max_concurrent: 14\n  lock_wait_minutes: 3\n");
    try {
      expect(cfg.agentsUserDrift()).toEqual([
        { key: "max_concurrent", mine: 14, theirs: 8 },
      ]);
    } finally {
      clear();
    }
    expect(cfg.agentsUserDrift()).toEqual([]);
  });

  it("Doctor notes a limit both files set differently: user.yml's wins", async () => {
    const doctor = await import("../../../src/ui/cli/doctor-command.js");
    const r = doctor.configLines(
      "Acme",
      () => null,
      () => [],
      () => [{ key: "max_concurrent", mine: 14, theirs: 8 }],
    );
    expect(r.lines).toContain(
      "  agents  ℹ  agents.max_concurrent: user.yml's 14 wins over the distribution's 8",
    );
    // A note, not a problem.
    expect(r.problem).toBe(false);
    expect(
      doctor.configLines(
        "Acme",
        () => null,
        () => [],
        () => [],
      ).lines,
    ).toEqual([]);
  });

  it("Settings saves agents.max_concurrent to user.yml, in range", () => {
    const user: Record<string, unknown> = {};
    expect(
      rows.patchCliRows(user, { agents_limits: { max_concurrent: 14 } }),
    ).toEqual({ ok: true });
    expect(user.agents).toEqual({ max_concurrent: 14 });
    // Other keys of the person's agents block stay.
    const kept: Record<string, unknown> = { agents: { sandbox: "off" } };
    rows.patchCliRows(kept, { agents_limits: { max_concurrent: 5 } });
    expect(kept.agents).toEqual({ sandbox: "off", max_concurrent: 5 });
    rows.patchCliRows(kept, { agents_limits: { max_concurrent: null } });
    expect(kept.agents).toEqual({ sandbox: "off" });
    expect(
      rows.patchCliRows(user, { agents_limits: { max_concurrent: null } }),
    ).toEqual({ ok: true });
    expect(user.agents).toBeUndefined();
  });

  it("Settings' agent limits are the person's; an agent proposes them, held", () => {
    expect(rows.PERSON_ONLY_SETTINGS).toContain("agents_limits");
  });

  it("Settings refuses a value out of range, and a key that is no limit", () => {
    for (const bad of [0, 2.5, "many"]) {
      const user: Record<string, unknown> = {};
      const r = rows.patchCliRows(user, {
        agents_limits: { max_concurrent: bad },
      });
      expect(r.ok).toBe(false);
      expect((r as { error: string }).error).toMatch(/agents\.max_concurrent/);
      expect(user.agents).toBeUndefined();
    }
    const r = rows.patchCliRows(
      {},
      { agents_limits: { token_binding: false } },
    );
    expect(r.ok).toBe(false);
  });

  it("config agents.max_concurrent=14 saves 14; config agents.max_concurrent reads the value in force", async () => {
    const log = jest.spyOn(console, "log").mockImplementation(() => {});
    try {
      log.mockClear();
      await cli.cmdConfig(["agents.max_concurrent"]);
      expect(log.mock.calls.map((c) => String(c[0]))).toEqual(["8"]);
      await cli.cmdConfig(["agents.max_concurrent=14"]);
      expect(readUser().agents).toEqual({ max_concurrent: 14 });
      expect(cfg.readAgentsConfig().maxConcurrent).toBe(14);
      log.mockClear();
      await cli.cmdConfig(["agents.max_concurrent"]);
      expect(log.mock.calls.map((c) => String(c[0]))).toEqual(["14"]);
      await expect(cli.cmdConfig(["agents.max_concurrent=0"])).rejects.toThrow(
        /agents\.max_concurrent/,
      );
      expect(readUser().agents).toEqual({ max_concurrent: 14 });
    } finally {
      log.mockRestore();
      clear();
    }
  });
});
