/**
 * Issue 974: secret-looking variables are held out of agent sessions.
 * One known fake secret (CANARY) is put into each place a session could
 * see it, and each test checks it is not there: the session's env, the
 * shell after a profile set it again (exported or not), the launch command
 * and its first prompt, the script Den writes, and doctor's lines (names
 * only). Then the rollout: an agent from before keeps its environment, a
 * new one doesn't, the held writes turn it on, and the allow-list's three
 * levels (install, project, agent) add up.
 */
import { afterAll, afterEach, describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  DEFAULT_ENV_HOLD,
  ENV_HOLD_FILE,
  allowedFor,
  applyEnvHold,
  checkEnvHoldConfig,
  envHoldScript,
  holdOutcome,
  matchesHold,
} from "../../../src/shared/agents/env-hold.js";
import {
  askEnvHold,
  envAllowKeepOp,
  envHoldOnOp,
  holdOnAtStart,
  legacyHoldIds,
  wouldHold,
  ENV_ALLOW_KEEP_ACTION,
  ENV_HOLD_ON_ACTION,
} from "../../../src/shared/agents/env-hold-rollout.js";
import { agentSessionEnv } from "../../../src/shared/agents/runtimes.js";
import { ACTOR_TOKEN_FILE_ENV } from "../../../src/shared/actor-token.js";
import { readAgentsConfig } from "../../../src/shared/den-config.js";
import { readRecord, writeRecord } from "../../../src/shared/agents/records.js";
import { envHoldLines } from "../../../src/ui/cli/doctor-env-hold.js";
import { cmdAgents } from "../../../src/ui/cli/agents-command.js";
import { agentGitEnv } from "../../../src/shared/agents/git-signing.js";
import { cleanupRigs, rig, settle, type Rig } from "./helpers/rig.js";

const CANARY = "canary-7f3e1d-not-a-real-secret";

const dir = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), "den-env-hold-")),
);
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
afterEach(cleanupRigs);

const agents = (r: Rig, ...args: string[]) => cmdAgents(args, r.deps);

describe("the rule a name is held by", () => {
  it.each([
    ["GH_TOKEN", true],
    ["OP_SERVICE_ACCOUNT_TOKEN", true],
    ["AWS_SECRET", true],
    ["ANTHROPIC_API_KEY", true],
    ["DB_PASSWORD", true],
    ["OP_SESSION_myaccount", true],
    // Den's prefix is no exemption.
    ["DEN_FOO_TOKEN", true],
    ["DEN_HUB_TOKEN", true],
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

  it("only the exact names Den set are kept: DEN_* is not, a person's credential never is, other GIT_CONFIG_* names are held", () => {
    const { held } = holdOutcome(
      [
        ACTOR_TOKEN_FILE_ENV,
        "GIT_CONFIG_KEY_0",
        "GIT_CONFIG_VALUE_9",
        "DEN_FOO_TOKEN",
        "DEN_PERSON_TOKEN",
        "X_TOKEN",
      ],
      ["*TOKEN*", "*_KEY"],
      ["DEN_PERSON_TOKEN"],
      [ACTOR_TOKEN_FILE_ENV, "GIT_CONFIG_KEY_0", "DEN_PERSON_TOKEN"],
    );
    expect(held).toEqual([
      "DEN_FOO_TOKEN",
      "DEN_PERSON_TOKEN",
      "GIT_CONFIG_VALUE_9",
      "X_TOKEN",
    ]);
  });
});

describe("the settings, in config/local/user.yml", () => {
  const user = (agents: Record<string, unknown>) =>
    readAgentsConfig({ agents: {} } as never, { agents } as never);

  it("unset: the default list, the guard on, nothing allowed, agents from before keep theirs", () => {
    const s = checkEnvHoldConfig({});
    expect(s.hold).toEqual([...DEFAULT_ENV_HOLD]);
    expect(s.holdSet).toBe(false);
    expect(s.guard).toBe(true);
    expect(s.allowAll).toEqual([]);
    expect(s.allow).toEqual({});
    expect(s.holdExisting).toBe(false);
  });

  // Issue 1391: a personal install is open unless the person sets it;
  // strict (a team's or enterprise's install) holds the default list.
  it("a personal install (the default) holds nothing back unless agents.env_hold is set; the guard stays on", () => {
    const s = user({}).envHold!;
    expect(s.hold).toEqual([]);
    expect(s.holdSet).toBe(false);
    expect(s.guard).toBe(true);
    expect(applyEnvHold({ GH_TOKEN: CANARY }, s.hold)).toHaveProperty(
      "GH_TOKEN",
    );
    expect(wouldHold([{ id: "a" }], s, ["GH_TOKEN"])).toEqual([
      { id: "a", names: [] },
    ]);
    expect(user({ env_hold: ["*_TOKEN"] }).envHold!.hold).toEqual(["*_TOKEN"]);
  });

  it("a strict install holds the default list, set in user.yml or the distribution's den.yml", () => {
    expect(
      readAgentsConfig(
        { agents: {} } as never,
        {
          install_mode: "strict",
        } as never,
      ).envHold!.hold,
    ).toEqual([...DEFAULT_ENV_HOLD]);
    expect(
      readAgentsConfig(
        { agents: {}, install_mode: "strict" } as never,
        {
          install_mode: "personal",
        } as never,
      ).envHold!.hold,
    ).toEqual([...DEFAULT_ENV_HOLD]);
  });

  it("an empty list holds nothing back, and stays empty (no quiet default)", () => {
    const s = user({ env_hold: [] }).envHold!;
    expect(s.hold).toEqual([]);
    expect(s.holdSet).toBe(true);
    expect(applyEnvHold({ GH_TOKEN: CANARY }, s.hold)).toHaveProperty(
      "GH_TOKEN",
    );
  });

  it("a changed list is used as written: a custom pattern holds a name the default misses, and the default's are no longer held", () => {
    const s = user({ env_hold: ["VAULT_*"] }).envHold!;
    expect(s.hold).toEqual(["VAULT_*"]);
    expect(matchesHold("VAULT_ADDR_SEAL", DEFAULT_ENV_HOLD)).toBe(false);
    const out = applyEnvHold(
      { VAULT_ADDR_SEAL: CANARY, GH_TOKEN: "x" },
      s.hold,
    );
    expect(out).not.toHaveProperty("VAULT_ADDR_SEAL");
    expect(out).toHaveProperty("GH_TOKEN");
  });

  it("set in the distribution's config, it is refused, naming user.yml", () => {
    expect(() =>
      readAgentsConfig({ agents: { env_allow: ["X"] } } as never, {}),
    ).toThrow(/config\/local\/user\.yml/);
  });

  it.each([
    [{ env_hold: "*_TOKEN" }, /agents\.env_hold: must be a list/],
    [{ env_hold: ["*"] }, /not a name pattern/],
    [{ env_hold: ["$(id)"] }, /not a name pattern/],
    [{ env_allow: { planner: ["X"] } }, /agents\.env_allow: must be a list/],
    [{ env_allow: ["A B"] }, /not a variable name/],
    [
      { env_allow_agents: ["X"] },
      /agents\.env_allow_agents: must be a mapping/,
    ],
    [
      { env_allow_agents: { planner: "X" } },
      /agents\.env_allow_agents\.planner: must be a list/,
    ],
    [{ env_guard: "no" }, /agents\.env_guard: true or false/],
    [{ env_hold_existing: 1 }, /agents\.env_hold_existing: true or false/],
  ])("%j is refused, naming the key", (raw, why) => {
    expect(() => checkEnvHoldConfig(raw)).toThrow(why);
  });

  it("the allow-list's levels add up: install, project, agent", () => {
    const s = checkEnvHoldConfig({
      env_allow: ["A_TOKEN"],
      env_allow_agents: { planner: ["C_TOKEN"] },
    });
    expect(allowedFor(s, "planner", ["B_TOKEN"]).sort()).toEqual([
      "A_TOKEN",
      "B_TOKEN",
      "C_TOKEN",
    ]);
    expect(allowedFor(s, "other")).toEqual(["A_TOKEN"]);
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

  it("an allowed name reaches it", () => {
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
});

/** Run `holdFile` in `shell` as the runtime does: profile, Den's file, then the command. */
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

/** `NAME=[value]` for each name, as the shell has it (exported or not). */
const show = (names: string[]) =>
  names.map((n) => `printf '%s=[%s]\\n' ${n} "\${${n}-}"`).join("; ");

describe("the shell, after a profile sets the canary again", () => {
  const file = path.join(dir, ENV_HOLD_FILE);
  fs.writeFileSync(
    file,
    envHoldScript(
      DEFAULT_ENV_HOLD,
      ["KEEP_TOKEN", "DEN_PERSON_TOKEN"],
      [ACTOR_TOKEN_FILE_ENV, "GIT_CONFIG_KEY_0"],
      // Den's own git value comes back as Den set it, not from the own list.
      { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "user.signingkey" },
    ),
  );
  const profile = [
    `export CANARY_TOKEN=${CANARY}`,
    `export my_token=${CANARY}`,
    `export AWS_KEY_2=${CANARY}`,
    // Not exported: still a shell variable a command can read.
    `GH_TOKEN=${CANARY}`,
    `export DEN_FOO_TOKEN=${CANARY}`,
    `export DEN_PERSON_TOKEN=${CANARY}`,
    `export GIT_CONFIG_VALUE_9=${CANARY}`,
    `export SOME_VALUE=den_pt_${CANARY}`,
    `export KEEP_TOKEN=kept`,
    `export ${ACTOR_TOKEN_FILE_ENV}=/state/token`,
    `export GIT_CONFIG_KEY_0=user.signingkey`,
    `export PLAIN_VALUE=plain`,
  ].join("\n");
  const names = [
    "CANARY_TOKEN",
    "my_token",
    "AWS_KEY_2",
    "GH_TOKEN",
    "DEN_FOO_TOKEN",
    "DEN_PERSON_TOKEN",
    "GIT_CONFIG_VALUE_9",
    "SOME_VALUE",
    "KEEP_TOKEN",
    ACTOR_TOKEN_FILE_ENV,
    "GIT_CONFIG_KEY_0",
    "PLAIN_VALUE",
  ];

  it.each(["/bin/sh", "/bin/bash", "/bin/zsh", "/bin/dash", "/usr/bin/dash"])(
    "%s: the canary is gone (exported or not, DEN_ prefix or not, a person's credential even when allowed); allowed, Den's exact and plain names stay",
    (shell) => {
      const out = inShell(shell, profile, file, `env; ${show(names)}`);
      if (out === null) return;
      expect(out).not.toContain(CANARY);
      expect(out).toContain("KEEP_TOKEN=[kept]");
      expect(out).toContain(`${ACTOR_TOKEN_FILE_ENV}=[/state/token]`);
      expect(out).toContain("GIT_CONFIG_KEY_0=[user.signingkey]");
      expect(out).toContain("PLAIN_VALUE=[plain]");
    },
  );

  it("the script names patterns and names only, never a value", () => {
    const s = fs.readFileSync(file, "utf-8");
    expect(s).not.toContain(CANARY);
    expect(s).toContain("KEEP_TOKEN");
    // It says which setting to ask for.
    expect(s).toContain("agents.env_allow");
  });

  it("an empty list: the script holds nothing back but a person's credential, and says so", () => {
    const empty = path.join(dir, "empty-hold.sh");
    fs.writeFileSync(empty, envHoldScript([]));
    expect(fs.readFileSync(empty, "utf-8")).toMatch(/list is empty/);
    const out = inShell(
      "/bin/sh",
      profile,
      empty,
      show(["CANARY_TOKEN", "DEN_PERSON_TOKEN"]),
    );
    expect(out).toContain(`CANARY_TOKEN=[${CANARY}]`);
    expect(out).toContain("DEN_PERSON_TOKEN=[]");
  });
});

describe("agents start", () => {
  it("a new agent: no canary in its env or command line, and env-hold.sh holds a profile's token back", async () => {
    const r = await rig();
    r.deps.env = { ...r.deps.env, CANARY_TOKEN: CANARY };
    expect(
      await agents(r, "start", "-w", "north", "--persona", "planner"),
    ).toBe(0);
    const first = r.made[0].opts;
    expect(first.env).not.toHaveProperty("CANARY_TOKEN");
    expect(Object.values(first.env)).not.toContain(CANARY);
    expect(r.made[0].args.join(" ")).not.toContain(CANARY);
    const file = first.env.CLAUDE_ENV_FILE!;
    expect(path.basename(file)).toBe(ENV_HOLD_FILE);
    expect(fs.readFileSync(file, "utf-8")).not.toContain(CANARY);
    const out = inShell(
      "/bin/sh",
      `export OP_SERVICE_ACCOUNT_TOKEN=${CANARY}`,
      file,
      show(["OP_SERVICE_ACCOUNT_TOKEN"]),
    );
    expect(out).toContain("OP_SERVICE_ACCOUNT_TOKEN=[]");
    expect(readRecord(r.stateDir, "planner")?.envHold).toEqual({
      applied: true,
    });
  });

  it("env-hold.sh is rewritten at every start", async () => {
    const r = await rig();
    await agents(r, "start", "-w", "north", "--persona", "planner");
    const file = r.made[0].opts.env.CLAUDE_ENV_FILE!;
    fs.appendFileSync(file, `\nexport GH_TOKEN=${CANARY}\n`);
    r.made[0].exit(0);
    await settle();
    r.config.envHold = {
      ...checkEnvHoldConfig({}),
      allowAll: ["LATER_TOKEN"],
    };
    expect(await agents(r, "resume", "planner")).toBe(0);
    const text = fs.readFileSync(file, "utf-8");
    expect(text).not.toContain(CANARY);
    expect(text).toContain("LATER_TOKEN");
  });

  it("an agent from before the update keeps its environment (OP_SERVICE_ACCOUNT_TOKEN stays); the held write turns the hold on at its next start", async () => {
    const r = await rig();
    await agents(r, "start", "-w", "north", "--persona", "planner");
    r.made[0].exit(0);
    await settle();
    // As a record from before 974 reads: no envHold.
    const rec = readRecord(r.stateDir, "planner")!;
    delete rec.envHold;
    writeRecord(r.stateDir, rec);

    expect(await agents(r, "resume", "planner")).toBe(0);
    const legacy = r.made[r.made.length - 1].opts.env;
    expect(legacy).not.toHaveProperty("CLAUDE_ENV_FILE");
    expect(readRecord(r.stateDir, "planner")?.envHold).toEqual({
      applied: false,
      legacy: true,
    });
    expect(
      legacyHoldIds(
        [readRecord(r.stateDir, "planner")!],
        r.config.envHold ?? checkEnvHoldConfig({}),
      ),
    ).toEqual(["planner"]);

    // "Remove": the held write sets agents.env_hold_existing: true.
    const turnedOn: string[] = [];
    const op = envHoldOnOp({
      rows: () => [{ id: "planner", names: ["OP_SERVICE_ACCOUNT_TOKEN"] }],
      turnOn: () => {
        turnedOn.push("on");
        r.config.envHold = { ...checkEnvHoldConfig({}), holdExisting: true };
      },
      keep: () => undefined,
    });
    const c = op.check({});
    expect(c.ok && c.personOnly).toBe(true);
    expect(c.ok && c.summary).toContain("OP_SERVICE_ACCOUNT_TOKEN");
    expect((await op.run({})).ok).toBe(true);
    expect(turnedOn).toEqual(["on"]);

    r.made[r.made.length - 1].exit(0);
    await settle();
    expect(await agents(r, "resume", "planner")).toBe(0);
    const now = r.made[r.made.length - 1].opts.env;
    expect(path.basename(now.CLAUDE_ENV_FILE ?? "")).toBe(ENV_HOLD_FILE);
    expect(readRecord(r.stateDir, "planner")?.envHold).toEqual({
      applied: true,
    });
  });

  it("an install-level allow-list of one name: a new agent keeps it and loses the other held ones", async () => {
    const r = await rig();
    r.deps.env = {
      ...r.deps.env,
      OP_SERVICE_ACCOUNT_TOKEN: CANARY,
      OTHER_TOKEN: CANARY,
    };
    r.config.envHold = {
      ...checkEnvHoldConfig({ env_allow: ["OP_SERVICE_ACCOUNT_TOKEN"] }),
    };
    await agents(r, "start", "-w", "north", "--persona", "planner");
    const env = r.made[0].opts.env;
    expect(env.OP_SERVICE_ACCOUNT_TOKEN).toBe(CANARY);
    expect(env).not.toHaveProperty("OTHER_TOKEN");
    const out = inShell(
      "/bin/sh",
      `export OP_SERVICE_ACCOUNT_TOKEN=${CANARY}\nexport OTHER_TOKEN=${CANARY}`,
      env.CLAUDE_ENV_FILE!,
      show(["OP_SERVICE_ACCOUNT_TOKEN", "OTHER_TOKEN"]),
    );
    expect(out).toContain(`OP_SERVICE_ACCOUNT_TOKEN=[${CANARY}]`);
    expect(out).toContain("OTHER_TOKEN=[]");
  });

  it("a project-level allow-list: that project's agent keeps the name, another project's doesn't", async () => {
    const r = await rig();
    r.deps.workspaceEnvAllow = (ws) =>
      ws === "north" ? ["PROJECT_TOKEN"] : undefined;
    await agents(r, "start", "-w", "north", "--persona", "planner");
    await agents(
      r,
      "start",
      "-w",
      "south",
      "--persona",
      "planner",
      "--id",
      "south-planner",
    );
    const north = fs.readFileSync(r.made[0].opts.env.CLAUDE_ENV_FILE!, "utf-8");
    const south = fs.readFileSync(
      r.made[r.made.length - 1].opts.env.CLAUDE_ENV_FILE!,
      "utf-8",
    );
    expect(north).toContain("PROJECT_TOKEN");
    expect(south).not.toContain("PROJECT_TOKEN");
  });
});

describe("the rollout's held writes and the bell", () => {
  const rows = () => [
    { id: "a", names: ["GH_TOKEN", "OP_SERVICE_ACCOUNT_TOKEN"] },
    { id: "b", names: ["GH_TOKEN"] },
  ];

  it("Keep these adds the named variables to the install's list and turns the hold on; a name no agent would lose is refused", async () => {
    const kept: string[][] = [];
    let on = false;
    const op = envAllowKeepOp({
      rows,
      turnOn: () => {
        on = true;
      },
      keep: (n) => kept.push(n),
    });
    const bad = op.check({ names: ["NOT_HELD"] });
    expect(bad.ok).toBe(false);
    const c = op.check({ names: ["OP_SERVICE_ACCOUNT_TOKEN"] });
    expect(c.ok && c.personOnly).toBe(true);
    expect((await op.run({ names: ["OP_SERVICE_ACCOUNT_TOKEN"] })).ok).toBe(
      true,
    );
    expect(kept).toEqual([["OP_SERVICE_ACCOUNT_TOKEN"]]);
    expect(on).toBe(true);
  });

  it("Den asks once: both writes, naming every variable; not again while one waits", async () => {
    const asked: { action: string; summary: string }[] = [];
    const queue = {
      pending: () => asked,
      request: (r: { action: string; summary: string }) => asked.push(r),
    };
    const deps = { rows, turnOn: () => undefined, keep: () => undefined };
    expect(
      await askEnvHold(queue, envAllowKeepOp(deps), envHoldOnOp(deps), rows),
    ).toBe(true);
    expect(asked.map((a) => a.action)).toEqual([
      ENV_ALLOW_KEEP_ACTION,
      ENV_HOLD_ON_ACTION,
    ]);
    expect(asked[0].summary).toContain("GH_TOKEN, OP_SERVICE_ACCOUNT_TOKEN");
    expect(
      await askEnvHold(queue, envAllowKeepOp(deps), envHoldOnOp(deps), rows),
    ).toBe(false);
  });

  it("holdOnAtStart: new on, from before off, on once env_hold_existing is set", () => {
    const s = checkEnvHoldConfig({});
    expect(holdOnAtStart(null, s)).toBe(true);
    expect(holdOnAtStart({ id: "a" }, s)).toBe(false);
    expect(holdOnAtStart({ id: "a", envHold: { applied: true } }, s)).toBe(
      true,
    );
    expect(holdOnAtStart({ id: "a" }, { ...s, holdExisting: true })).toBe(true);
  });
});

describe("doctor: names only", () => {
  const names = ["CANARY_TOKEN", "KEEP_TOKEN", "PATH", ACTOR_TOKEN_FILE_ENV];

  it("held back and let through, by name, and which runtimes hold them in shell commands", () => {
    const s = {
      ...checkEnvHoldConfig({}),
      allow: { planner: ["KEEP_TOKEN"] },
    };
    const lines = envHoldLines("Den", s, names).lines.join("\n");
    expect(lines).toMatch(/held back: CANARY_TOKEN/);
    expect(lines).toMatch(/planner: let through: KEEP_TOKEN/);
    expect(lines).toMatch(/shell commands hold them back for den-claude/);
    expect(lines).not.toMatch(/held back:.*DEN_ACTOR_TOKEN_FILE/);
    expect(lines).not.toContain(CANARY);
  });

  it("each agent from before the hold, with the names it still gets (⚠)", () => {
    const s = checkEnvHoldConfig({});
    const legacy = wouldHold(
      [{ id: "old-one" }, { id: "new-one", envHold: { applied: true } }],
      s,
      ["OP_SERVICE_ACCOUNT_TOKEN", "PATH"],
    );
    expect(legacy).toEqual([
      { id: "old-one", names: ["OP_SERVICE_ACCOUNT_TOKEN"] },
    ]);
    const lines = envHoldLines("Den", s, names, legacy).lines.join("\n");
    expect(lines).toMatch(/⚠\s+1 agent started before the hold/);
    expect(lines).toMatch(/old-one: OP_SERVICE_ACCOUNT_TOKEN/);
  });

  it("an empty list is said plainly", () => {
    const s = checkEnvHoldConfig({ env_hold: [] });
    const lines = envHoldLines("Den", s, names).lines.join("\n");
    expect(lines).toContain("secret list is empty: nothing is held back");
  });

  it("a personal install's open default is said as such, with how to turn the hold on", () => {
    const s = { ...checkEnvHoldConfig({}), hold: [] };
    const lines = envHoldLines("Den", s, names).lines.join("\n");
    expect(lines).toMatch(
      /ℹ\s+off on a personal install: nothing is held back/,
    );
    expect(lines).toMatch(/agents\.env_hold.*install_mode: strict/);
    expect(lines).not.toContain("secret list is empty");
  });

  it("the guard: on says it is not a boundary; off is said", () => {
    expect(
      envHoldLines("Den", checkEnvHoldConfig({}), names).lines.join("\n"),
    ).toMatch(/not a boundary/);
    const off = checkEnvHoldConfig({ env_guard: false });
    expect(envHoldLines("Den", off, names).lines.join("\n")).toMatch(
      /agents\.env_guard is false/,
    );
  });
});

describe("git's config names: Den's own values for this start, never a profile's", () => {
  const KEY = "/keys/agents/id_ed25519";
  const den = agentGitEnv({ signingKey: KEY });
  const pair = [
    "export GIT_CONFIG_COUNT=1",
    "export GIT_CONFIG_KEY_0=http.extraHeader",
    `export GIT_CONFIG_VALUE_0="Authorization: Bearer ${CANARY}"`,
  ].join("\n");
  const names = [
    "GIT_CONFIG_COUNT",
    "GIT_CONFIG_KEY_0",
    "GIT_CONFIG_VALUE_0",
    "GIT_CONFIG_VALUE_1",
  ];
  // Den's launch once listed git's names as its own: they never exempt a
  // profile's value.
  const own = ["GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"];
  const script = (
    name: string,
    hold: readonly string[],
    git: Record<string, string>,
  ) => {
    const f = path.join(dir, name);
    fs.writeFileSync(f, envHoldScript(hold, [], own, git));
    return f;
  };

  it.each(["/bin/sh", "/bin/bash", "/bin/zsh"])(
    "%s: signing failed (Den set none): a profile's GIT_CONFIG_KEY_0/VALUE_0 pair is gone",
    (shell) => {
      const out = inShell(
        shell,
        pair,
        script("git-none.sh", DEFAULT_ENV_HOLD, {}),
        show(names),
      );
      if (out === null) return;
      expect(out).not.toContain(CANARY);
      expect(out).toContain("GIT_CONFIG_COUNT=[]");
      expect(out).toContain("GIT_CONFIG_KEY_0=[]");
    },
  );

  it.each(["/bin/sh", "/bin/bash", "/bin/zsh"])(
    "%s: signing on: a profile overwriting GIT_CONFIG_VALUE_1 ends with Den's value, on strict and personal",
    (shell) => {
      for (const hold of [DEFAULT_ENV_HOLD, []]) {
        const out = inShell(
          shell,
          `${pair}\nexport GIT_CONFIG_VALUE_1=/evil/key`,
          script(`git-on-${hold.length}.sh`, hold, den),
          show(names),
        );
        if (out === null) return;
        expect(out).toContain(`GIT_CONFIG_VALUE_1=[${KEY}]`);
        expect(out).toContain(`GIT_CONFIG_COUNT=[${den.GIT_CONFIG_COUNT}]`);
        expect(out).toContain("GIT_CONFIG_KEY_0=[gpg.format]");
        expect(out).not.toContain(CANARY);
        expect(out).not.toContain("/evil/key");
      }
    },
  );

  it("personal with Den setting none: a profile's git config is left alone (the open default)", () => {
    const out = inShell(
      "/bin/sh",
      pair,
      script("git-open.sh", [], {}),
      show(names),
    );
    expect(out).toContain("GIT_CONFIG_KEY_0=[http.extraHeader]");
  });

  it("signing on: a commit still signs, after a profile overwrote Den's key", () => {
    const has = (b: string) =>
      spawnSync("sh", ["-c", `command -v ${b}`]).status === 0;
    if (!has("git") || !has("ssh-keygen")) return;
    const g = fs.mkdtempSync(path.join(dir, "sign-"));
    const key = path.join(g, "id_ed25519");
    spawnSync("ssh-keygen", [
      "-q",
      "-t",
      "ed25519",
      "-N",
      "",
      "-C",
      "den-agents@den.invalid",
      "-f",
      key,
    ]);
    const signers = path.join(g, "allowed_signers");
    fs.writeFileSync(
      signers,
      `den-agents@den.invalid ${fs.readFileSync(`${key}.pub`, "utf-8")}`,
    );
    const repo = path.join(g, "repo");
    spawnSync("git", ["init", "-q", repo]);
    const f = path.join(dir, "git-sign.sh");
    fs.writeFileSync(
      f,
      envHoldScript(
        DEFAULT_ENV_HOLD,
        [],
        [],
        agentGitEnv({ signingKey: key, allowedSigners: signers }),
      ),
    );
    const out = inShell(
      "/bin/sh",
      "export GIT_CONFIG_COUNT=1\nexport GIT_CONFIG_KEY_0=commit.gpgsign\nexport GIT_CONFIG_VALUE_0=false",
      f,
      `cd ${repo} && git -c user.name=t -c user.email=den-agents@den.invalid commit -q --allow-empty -m x && git log -1 --format=%G?`,
    );
    expect(String(out).trim()).toBe("G");
  });

  it("an agent's start writes Den's values for the key it resolved, and none when there is none", async () => {
    for (const signing of [
      { signingKey: KEY, source: "setting" as const },
      undefined,
    ]) {
      const r = await rig();
      r.deps.agentSigning = () => signing;
      expect(
        await agents(r, "start", "-w", "north", "--persona", "planner"),
      ).toBe(0);
      const text = fs.readFileSync(
        r.made[0].opts.env.CLAUDE_ENV_FILE!,
        "utf-8",
      );
      if (signing) expect(text).toContain(`export GIT_CONFIG_VALUE_1='${KEY}'`);
      else expect(text).not.toMatch(/^export GIT_CONFIG/m);
      expect(text).toMatch(/GIT_CONFIG_\*\) unset/);
    }
  });
});
