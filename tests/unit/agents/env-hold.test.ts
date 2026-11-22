/**
 * Issue 974: secret-looking variables are held out of agent sessions.
 * One known fake secret (CANARY) is put into each place a session could
 * see it, and each test checks it is not there: the session's env, the
 * shell after a profile set it again, the launch command and its first
 * prompt, the script Den writes, and doctor's lines (names only).
 */
import { afterAll, afterEach, describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  DEFAULT_ENV_HOLD,
  ENV_HOLD_FILE,
  applyEnvHold,
  checkEnvHoldConfig,
  envHoldScript,
  holdOutcome,
  matchesHold,
} from "../../../src/shared/agents/env-hold.js";
import { agentSessionEnv } from "../../../src/shared/agents/runtimes.js";
import { ACTOR_TOKEN_FILE_ENV } from "../../../src/shared/actor-token.js";
import { readAgentsConfig } from "../../../src/shared/den-config.js";
import { envHoldLines } from "../../../src/ui/cli/doctor-env-hold.js";
import { cmdAgents } from "../../../src/ui/cli/agents-command.js";
import { cleanupRigs, rig } from "./helpers/rig.js";

const CANARY = "canary-7f3e1d-not-a-real-secret";

const dir = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), "den-env-hold-")),
);
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
afterEach(cleanupRigs);

describe("the rule a name is held by", () => {
  it.each([
    ["GH_TOKEN", true],
    ["OP_SERVICE_ACCOUNT_TOKEN", true],
    ["AWS_SECRET", true],
    ["ANTHROPIC_API_KEY", true],
    ["DB_PASSWORD", true],
    ["OP_SESSION_myaccount", true],
    // Case is ignored.
    ["my_token", true],
    ["Db_Password", true],
    // A name may end in _ and a digit: AWS_KEY_2.
    ["AWS_KEY_2", true],
    ["API_TOKEN_10", true],
    ["PATH", false],
    ["HOME", false],
    ["TOKENIZER", false],
    ["KEYBOARD_LAYOUT", false],
    ["LANG", false],
  ])("%s held by the default list: %s", (name, held) => {
    expect(matchesHold(name, DEFAULT_ENV_HOLD)).toBe(held);
  });

  it("Den's own variables are never held, even when a pattern matches them", () => {
    const { held } = holdOutcome(
      [ACTOR_TOKEN_FILE_ENV, "DEN_AGENT", "GIT_CONFIG_KEY_0", "X_TOKEN"],
      ["*TOKEN*", "*_KEY"],
    );
    expect(held).toEqual(["X_TOKEN"]);
  });
});

describe("agents.env_hold, env_allow and env_guard", () => {
  it("unset: the default list, the guard on, nobody opted in", () => {
    const s = checkEnvHoldConfig({});
    expect(s.hold).toEqual([...DEFAULT_ENV_HOLD]);
    expect(s.holdSet).toBe(false);
    expect(s.guard).toBe(true);
    expect(s.allow).toEqual({});
  });

  it("unset in den.yml reads as the default list", () => {
    const cfg = readAgentsConfig({ agents: {} } as never, {});
    expect(cfg.envHold?.hold).toEqual([...DEFAULT_ENV_HOLD]);
    expect(cfg.envHold?.holdSet).toBe(false);
  });

  it("an empty list holds nothing back, and stays empty (no quiet default)", () => {
    const cfg = readAgentsConfig({ agents: { env_hold: [] } } as never, {});
    expect(cfg.envHold?.hold).toEqual([]);
    expect(cfg.envHold?.holdSet).toBe(true);
    expect(
      applyEnvHold({ GH_TOKEN: CANARY }, cfg.envHold!.hold),
    ).toHaveProperty("GH_TOKEN");
  });

  it("a changed list is used as written: a custom pattern holds a name the default misses, and the default's are no longer held", () => {
    const cfg = readAgentsConfig(
      { agents: { env_hold: ["VAULT_*"] } } as never,
      {},
    );
    expect(cfg.envHold?.hold).toEqual(["VAULT_*"]);
    expect(matchesHold("VAULT_ADDR_SEAL", DEFAULT_ENV_HOLD)).toBe(false);
    const out = applyEnvHold(
      { VAULT_ADDR_SEAL: CANARY, GH_TOKEN: "x" },
      cfg.envHold!.hold,
    );
    expect(out).not.toHaveProperty("VAULT_ADDR_SEAL");
    expect(out).toHaveProperty("GH_TOKEN");
  });

  it.each([
    [{ env_hold: "*_TOKEN" }, /agents\.env_hold: must be a list/],
    [{ env_hold: ["*"] }, /not a name pattern/],
    [{ env_hold: ["$(id)"] }, /not a name pattern/],
    [{ env_allow: ["X"] }, /agents\.env_allow: must be a mapping/],
    [
      { env_allow: { planner: "X" } },
      /agents\.env_allow\.planner: must be a list/,
    ],
    [{ env_allow: { planner: ["A B"] } }, /not a variable name/],
    [{ env_guard: "no" }, /agents\.env_guard: true or false/],
  ])("%j is refused, naming the key", (raw, why) => {
    expect(() => checkEnvHoldConfig(raw)).toThrow(why);
  });

  it("the three keys are not taken for agent ids", () => {
    const cfg = readAgentsConfig(
      {
        agents: {
          env_hold: ["*_TOKEN"],
          env_allow: { planner: ["GH_TOKEN"] },
          env_guard: false,
        },
      } as never,
      {},
    );
    expect(Object.keys(cfg.agents)).toEqual([]);
    expect(cfg.envHold?.allow).toEqual({ planner: ["GH_TOKEN"] });
    expect(cfg.envHold?.guard).toBe(false);
  });
});

describe("the session's own environment", () => {
  it("a token-like variable from the caller doesn't reach it, even when the runtime passes it through", () => {
    const env = agentSessionEnv(
      { PATH: "/bin", HOME: "/h", CANARY_TOKEN: CANARY },
      { envPassthrough: ["CANARY_TOKEN"] },
      {},
      "planner",
      "/state/actor-token/planner/token",
    );
    expect(env).not.toHaveProperty("CANARY_TOKEN");
    expect(Object.values(env)).not.toContain(CANARY);
    // Den's own variable stays.
    expect(env[ACTOR_TOKEN_FILE_ENV]).toBe("/state/actor-token/planner/token");
  });

  it("an agent opted in by name gets it", () => {
    const env = agentSessionEnv(
      { PATH: "/bin", HOME: "/h", CANARY_TOKEN: CANARY },
      {},
      {},
      "planner",
      undefined,
      [],
      {},
      {},
      { hold: [...DEFAULT_ENV_HOLD], allow: ["CANARY_TOKEN"] },
    );
    expect(env.CANARY_TOKEN).toBe(CANARY);
  });

  it("agents start: no canary in the session's env or argv (its prompt) by default; the opted-in agent gets it", async () => {
    const r = await rig();
    r.deps.env = { ...r.deps.env, CANARY_TOKEN: CANARY };
    expect(
      await cmdAgents(["start", "-w", "north", "--persona", "planner"], r.deps),
    ).toBe(0);
    const first = r.made[0].opts;
    expect(first.env).not.toHaveProperty("CANARY_TOKEN");
    expect(Object.values(first.env)).not.toContain(CANARY);
    expect(r.made[0].args.join(" ")).not.toContain(CANARY);
    // The script the shell runs before each command, named in the env.
    const file = first.env.CLAUDE_ENV_FILE!;
    expect(path.basename(file)).toBe(ENV_HOLD_FILE);
    expect(fs.readFileSync(file, "utf-8")).not.toContain(CANARY);

    const o = await rig();
    o.deps.env = { ...o.deps.env, CANARY_TOKEN: CANARY };
    o.config.envHold = {
      ...checkEnvHoldConfig({}),
      allow: { planner: ["CANARY_TOKEN"] },
    };
    expect(
      await cmdAgents(["start", "-w", "north", "--persona", "planner"], o.deps),
    ).toBe(0);
    const second = o.made[0].opts;
    expect(fs.readFileSync(second.env.CLAUDE_ENV_FILE!, "utf-8")).toContain(
      "CANARY_TOKEN",
    );
    expect(second.env.CANARY_TOKEN).toBe(CANARY);
  });
});

/** Run `script` in `shell` the way the runtime does: profile, then Den's file, then the command. */
function inShell(
  shell: string,
  profile: string,
  holdFile: string,
  command: string,
): string | null {
  if (!fs.existsSync(shell)) return null;
  const zdot = fs.mkdtempSync(path.join(dir, "zdot-"));
  // zsh reads $ZDOTDIR/.zshenv for every shell, as a person's ~/.zshenv.
  fs.writeFileSync(path.join(zdot, ".zshenv"), profile);
  const r = spawnSync(
    shell,
    [
      "-c",
      `${shell.endsWith("zsh") ? "" : `${profile}\n`}. ${holdFile}\n${command}`,
    ],
    {
      encoding: "utf-8",
      env: { PATH: "/usr/bin:/bin", HOME: dir, ZDOTDIR: zdot },
    },
  );
  return r.stdout;
}

describe("the shell, after a profile sets the canary again", () => {
  const file = path.join(dir, ENV_HOLD_FILE);
  fs.writeFileSync(file, envHoldScript(DEFAULT_ENV_HOLD, ["KEEP_TOKEN"]));
  const profile = [
    `export CANARY_TOKEN=${CANARY}`,
    `export my_token=${CANARY}`,
    `export AWS_KEY_2=${CANARY}`,
    `export KEEP_TOKEN=kept`,
    `export DEN_ACTOR_TOKEN_FILE=/state/token`,
    `export PLAIN_VALUE=plain`,
  ].join("\n");

  it.each(["/bin/sh", "/bin/bash", "/bin/zsh"])(
    "%s: the canary is gone, opted-in, Den's and plain names stay",
    (shell) => {
      const out = inShell(
        shell,
        profile,
        file,
        "env; printenv KEEP_TOKEN DEN_ACTOR_TOKEN_FILE PLAIN_VALUE",
      );
      if (out === null) return;
      expect(out).not.toContain(CANARY);
      expect(out).toContain("kept");
      expect(out).toContain("/state/token");
      expect(out).toContain("plain");
    },
  );

  it("the script names patterns and names only, never a value", () => {
    const s = envHoldScript(DEFAULT_ENV_HOLD, ["KEEP_TOKEN"]);
    expect(s).not.toContain(CANARY);
    expect(s).toContain("KEEP_TOKEN");
  });

  it("an empty list: the script unsets nothing and says so", () => {
    const empty = path.join(dir, "empty-hold.sh");
    fs.writeFileSync(empty, envHoldScript([]));
    expect(fs.readFileSync(empty, "utf-8")).toMatch(/nothing is held back/);
    const out = inShell("/bin/sh", profile, empty, "printenv CANARY_TOKEN");
    expect(out).toContain(CANARY);
  });
});

describe("doctor: what was held back and what an opt-in let through, by name", () => {
  const names = ["CANARY_TOKEN", "KEEP_TOKEN", "PATH", "DEN_ACTOR_TOKEN_FILE"];

  it("lists names, never a value", () => {
    const s = {
      ...checkEnvHoldConfig({}),
      allow: { planner: ["KEEP_TOKEN"] },
    };
    const lines = envHoldLines("Den", s, names).lines.join("\n");
    expect(lines).toMatch(/held back: CANARY_TOKEN/);
    expect(lines).toMatch(/planner.*let through: KEEP_TOKEN/);
    expect(lines).not.toMatch(/held back:.*DEN_ACTOR_TOKEN_FILE/);
    expect(lines).not.toContain(CANARY);
  });

  it("an empty list is said plainly", () => {
    const s = checkEnvHoldConfig({ env_hold: [] });
    const lines = envHoldLines("Den", s, names).lines.join("\n");
    expect(lines).toContain("secret list is empty: nothing is held back");
  });

  it("the guard turned off is said", () => {
    const s = checkEnvHoldConfig({ env_guard: false });
    const lines = envHoldLines("Den", s, names).lines.join("\n");
    expect(lines).toMatch(/agents\.env_guard is false/);
  });
});
