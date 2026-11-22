/**
 * Issue 532: the terminal limits (sessions.max_concurrent,
 * close_grace_seconds, pty_close_seconds, pty_warn_above,
 * pty_machine_warn_percent) are Settings rows and `config` keys, saved to
 * user.yml, checked with den-config's own ranges and words; user.yml's
 * value wins over the distribution's den.yml.
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
const readUser = () =>
  (yaml.parse(fs.readFileSync(userYml(), "utf8")) ?? {}) as Record<
    string,
    unknown
  >;

beforeAll(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-532-")));
  fs.mkdirSync(path.join(root, "config", "local"), { recursive: true });
  fs.writeFileSync(path.join(root, "den.yml"), "product:\n  name: den\n");
  fs.writeFileSync(
    path.join(root, "config", "den.yml"),
    "environments: [local]\nsessions:\n  max_concurrent: 3\n  close_grace_seconds: 7\n",
  );
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

/** den-config's own words for a value of one key, or null when it takes it. */
function denConfigSays(key: string, value: unknown): string | null {
  try {
    cfg.readSessionsConfig({ sessions: { [key]: value } } as never);
    return null;
  } catch (e) {
    // The file's name aside: "sessions.<key>: must be …".
    return (e as Error).message.replace(/^[^:]*den\.yml: /, "");
  }
}

/** An error is den-config's words for it, then the value given. */
const saysAsDenConfig = (said: string) =>
  new RegExp(
    `^${said.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}( \\(got [^)]*\\))?$`,
  );

const KEYS = [
  "max_concurrent",
  "close_grace_seconds",
  "pty_close_seconds",
  "pty_warn_above",
  "pty_machine_warn_percent",
] as const;

/** For each key: a value in range, and values out of it. */
const CASES: Record<(typeof KEYS)[number], [unknown, unknown[]]> = {
  max_concurrent: [12, [0, 2.5, "many"]],
  close_grace_seconds: [10, [-1, 301, "soon"]],
  pty_close_seconds: [5, [-1, 86_401]],
  pty_warn_above: [800, [0, 1.5]],
  pty_machine_warn_percent: [80, [0, 101]],
};

describe("issue 532: the terminal limits in Settings and config", () => {
  it.each(KEYS)("Settings saves sessions.%s to user.yml, in range", (k) => {
    const user: Record<string, unknown> = {};
    const [good] = CASES[k];
    expect(rows.patchCliRows(user, { sessions: { [k]: good } })).toEqual({
      ok: true,
    });
    expect(user.sessions).toEqual({ [k]: good });
    expect(rows.patchCliRows(user, { sessions: { [k]: null } })).toEqual({
      ok: true,
    });
    expect(user.sessions).toBeUndefined();
  });

  it.each(KEYS)(
    "a value out of range for sessions.%s is refused with den-config's words",
    (k) => {
      for (const bad of CASES[k][1]) {
        const user: Record<string, unknown> = {};
        const said = denConfigSays(k, bad);
        expect(said).not.toBeNull();
        const r = rows.patchCliRows(user, { sessions: { [k]: bad } });
        expect(r.ok).toBe(false);
        expect((r as { error: string }).error).toMatch(saysAsDenConfig(said!));
        expect(user.sessions).toBeUndefined();
      }
    },
  );

  it("a key that is no terminal limit is refused", () => {
    const r = rows.patchCliRows({}, { sessions: { host_restart_note: true } });
    expect(r.ok).toBe(false);
  });

  it("user.yml's value wins over den.yml's; den.yml's others stand", () => {
    fs.writeFileSync(userYml(), "sessions:\n  max_concurrent: 9\n");
    const s = cfg.readSessionsConfig();
    expect(s.maxConcurrent).toBe(9);
    expect(s.closeGraceSeconds).toBe(7);
    fs.rmSync(userYml());
    expect(cfg.readSessionsConfig().maxConcurrent).toBe(3);
  });

  it("config sessions.pty_close_seconds=5 saves 5; config sessions.pty_close_seconds reads it", async () => {
    const log = jest.spyOn(console, "log").mockImplementation(() => {});
    try {
      await cli.cmdConfig(["sessions.pty_close_seconds=5"]);
      expect(readUser().sessions).toEqual({ pty_close_seconds: 5 });
      expect(cfg.readSessionsConfig().ptyCloseSeconds).toBe(5);
      log.mockClear();
      await cli.cmdConfig(["sessions.pty_close_seconds"]);
      expect(log.mock.calls.map((c) => String(c[0]))).toEqual(["5"]);
      // A key not set in user.yml reads as its effective value.
      log.mockClear();
      await cli.cmdConfig(["sessions.close_grace_seconds"]);
      expect(log.mock.calls.map((c) => String(c[0]))).toEqual(["7"]);
    } finally {
      log.mockRestore();
      fs.rmSync(userYml(), { force: true });
    }
  });

  it("config refuses a value out of range with den-config's words, and saves nothing", async () => {
    await expect(
      cli.cmdConfig(["sessions.pty_close_seconds=90000"]),
    ).rejects.toThrow(
      saysAsDenConfig(denConfigSays("pty_close_seconds", 90_000)!),
    );
    expect(fs.existsSync(userYml())).toBe(false);
  });

  it("config lists the five keys", () => {
    for (const k of KEYS)
      expect(cli.configKeyNames()).toContain(`sessions.${k}`);
  });
});
