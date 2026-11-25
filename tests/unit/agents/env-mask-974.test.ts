/**
 * Issue 974 (2), as ruled: a command that prints the environment runs, and
 * the values of secret-looking names are masked (`NAME=•••• (held)`) before
 * any pipe or redirect, so neither the transcript nor a file it writes gets
 * them. Den's PreToolUse hook rewrites the printing part into
 * `{ <it>; } | <Den's masker>`. The masked set is the hold's list
 * (agents.env_hold, else the default) and a person's credentials, from
 * agents/env-hold.ts, passed to the hook; the hook holds no list of its own.
 * A planted FAKE_TOKEN=abc123 never shows, its name does, and an ordinary
 * variable prints as before, in bash and zsh, on personal and strict.
 */
import { afterAll, describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  DEFAULT_ENV_HOLD,
  PERSON_CREDENTIAL_NAMES,
  envMaskArgs,
  matchesHold,
} from "../../../src/shared/agents/env-hold.js";
import { readAgentsConfig } from "../../../src/shared/den-config.js";

const RUN = path.resolve("tests/unit/agents/env-mask-run.mjs");

/** env-mask.mjs's own functions, run in node (jest can't import an .mjs). */
function masker(q: {
  names: string[] | null;
  values?: string[];
  text?: string;
  env?: Record<string, string>;
  check?: string[];
}): { out: string | null; names: boolean[] } {
  const r = spawnSync(process.execPath, [RUN], {
    input: JSON.stringify(q),
    encoding: "utf-8",
  });
  return JSON.parse(r.stdout);
}

const HOOK = path.resolve("src/shared/agents/guardrails/pretooluse.mjs");
const SECRET = "abc123";
const dir = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), "den-env-mask-")),
);
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const args = envMaskArgs(
  readAgentsConfig({ agents: {} } as never, {}).envHold!,
);
const FLAGS = ["--no-guardrails", ...args];

/** The hook's answer for one Bash command: its exit and rewritten command. */
function hook(command: string, flags: string[] = FLAGS) {
  const r = spawnSync(process.execPath, [HOOK, ...flags], {
    input: JSON.stringify({
      tool_name: "Bash",
      tool_input: { command },
      cwd: dir,
    }),
    encoding: "utf-8",
    env: { PATH: process.env.PATH ?? "", HOME: "/nowhere" },
  });
  let rewritten: string | null = null;
  try {
    rewritten =
      JSON.parse(r.stdout).hookSpecificOutput?.updatedInput?.command ?? null;
  } catch {
    rewritten = null;
  }
  return { code: r.status, rewritten, stderr: r.stderr };
}

const SHELLS = ["/bin/bash", "/bin/zsh"].filter((s) => fs.existsSync(s));

/** The rewritten command run in `shell`, with the planted variables. */
function run(
  shell: string,
  command: string,
  extra: Record<string, string> = {},
) {
  const r = spawnSync(shell, ["-c", command], {
    cwd: dir,
    encoding: "utf-8",
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: dir,
      FAKE_TOKEN: SECRET,
      PLAIN_VAR: "hello-plain",
      ...extra,
    },
  });
  return `${r.stdout}${r.stderr}`;
}

const PRINTERS = [
  "env",
  "printenv",
  "set",
  "/usr/bin/env",
  ...(fs.existsSync("/bin/env") ? ["/bin/env"] : []),
  "command env",
  "builtin set",
  "\\env",
  "env -0",
  "env -u X",
  "export -p",
  "declare -x",
  "declare -p",
  "typeset -x",
  "typeset -p",
  "printenv | cat",
  "env | grep -i token",
  "env | sort; echo done",
  "echo start && env",
];

describe("a command that prints the environment runs, its secret-looking values masked", () => {
  for (const shell of SHELLS)
    it.each(PRINTERS)(`${path.basename(shell)}: \`%s\``, (cmd) => {
      const h = hook(cmd);
      expect(h.code).toBe(0);
      expect(h.rewritten).toContain("env-mask.mjs");
      const out = run(shell, h.rewritten!);
      expect(out).not.toContain(SECRET);
      expect(out).toMatch(/FAKE_TOKEN/i);
      if (!/grep -i token/.test(cmd)) expect(out).toContain("hello-plain");
    });

  it.each(SHELLS)(
    "%s: printenv FAKE_TOKEN prints the mask, not the value",
    (shell) => {
      const h = hook("printenv FAKE_TOKEN");
      const out = run(shell, h.rewritten!);
      expect(out).not.toContain(SECRET);
      expect(out).toContain("••••");
      expect(run(shell, hook("printenv PLAIN_VAR").rewritten!)).toContain(
        "hello-plain",
      );
    },
  );

  it.each(SHELLS)("%s: env > f writes masked values to f", (shell) => {
    const f = path.join(dir, `e-${path.basename(shell)}.txt`);
    const h = hook(`env > ${f}; cat ${f}`);
    const out = run(shell, h.rewritten!);
    const file = fs.readFileSync(f, "utf-8");
    expect(file).not.toContain(SECRET);
    expect(file).toContain("FAKE_TOKEN=•••• (held)");
    expect(file).toContain("PLAIN_VAR=hello-plain");
    expect(out).not.toContain(SECRET);
  });

  it("a command that prints no environment is left as it is", () => {
    for (const cmd of [
      "echo $HOME",
      "env FOO=1 node -v",
      "export FOO=1",
      "set -e",
      "set -euo pipefail; ls",
      "cat environment.md",
    ])
      expect(hook(cmd).rewritten).toBeNull();
  });

  it("agents.env_guard: false (--no-env-guard) leaves it unmasked", () => {
    expect(hook("env", [...FLAGS, "--no-env-guard"]).rewritten).toBeNull();
  });
});

describe("the mask leaks no part of a value", () => {
  const mask = (text: string, env: Record<string, string>) =>
    masker({ names: ["*_TOKEN", "*_KEY"], values: ["*den_pt_*"], text, env })
      .out;

  it("a held line is the name and a fixed mark: no prefix, suffix or length", () => {
    const out = mask("FAKE_TOKEN=abc123xyz\nPLAIN=ok\n", {
      FAKE_TOKEN: "abc123xyz",
    });
    expect(out).toBe("FAKE_TOKEN=•••• (held)\nPLAIN=ok\n");
  });

  it("a value over several lines: no line of it shows", () => {
    const v = "-----BEGIN-----\nMIIEsecretline\n-----END-----";
    const out = mask(`DEPLOY_KEY=${v}\nPLAIN=ok\n`, {
      DEPLOY_KEY: v,
    });
    expect(out).not.toContain("MIIEsecretline");
    expect(out).not.toContain("BEGIN");
    expect(out).toContain("PLAIN=ok");
  });

  it("declare and export lines, and a person's credential by its value", () => {
    const out = mask(
      'declare -x GH_TOKEN="ghp_zzz"\nexport OTHER=den_pt_qqq\n',
      {},
    );
    expect(out).toBe(
      "declare -x GH_TOKEN=•••• (held)\nexport OTHER=•••• (held)\n",
    );
  });

  it("with no list passed, every value is masked (fails closed)", () => {
    const h = hook("env", ["--no-guardrails"]);
    for (const shell of SHELLS) {
      const out = run(shell, h.rewritten!);
      expect(out).not.toContain(SECRET);
      expect(out).not.toContain("hello-plain");
      expect(out).toContain("PLAIN_VAR=•••• (held)");
    }
  });
});

describe("the masked set comes from env-hold.ts, on personal and strict", () => {
  const masked = (agents: Record<string, unknown>, mode?: string) =>
    envMaskArgs(
      readAgentsConfig(
        { agents: {} } as never,
        { agents, ...(mode ? { install_mode: mode } : {}) } as never,
      ).envHold!,
    );

  it("personal and strict mask the default list and a person's credentials", () => {
    for (const mode of [undefined, "personal", "strict"]) {
      const a = masked({}, mode);
      const names = a[a.indexOf("--env-mask") + 1].split(",");
      expect(names).toEqual([...DEFAULT_ENV_HOLD, ...PERSON_CREDENTIAL_NAMES]);
    }
  });

  it("agents.env_hold set: its list; [] masks only a person's credentials", () => {
    const a = masked({ env_hold: ["VAULT_*"] });
    expect(a[a.indexOf("--env-mask") + 1]).toBe(
      ["VAULT_*", ...PERSON_CREDENTIAL_NAMES].join(","),
    );
    const e = masked({ env_hold: [] });
    expect(e[e.indexOf("--env-mask") + 1]).toBe(
      PERSON_CREDENTIAL_NAMES.join(","),
    );
  });

  it("the hook's matcher agrees with the hold's rule, name by name", () => {
    const check = [
      "GH_TOKEN",
      "gh_token",
      "AWS_KEY_2",
      "OP_SESSION_abc",
      "TOKENIZER",
      "KEYCHAIN",
      "PLAIN_VAR",
      "MY_SECRET_9x",
    ];
    const got = masker({ names: [...DEFAULT_ENV_HOLD], check }).names;
    expect(got).toEqual(check.map((n) => matchesHold(n, DEFAULT_ENV_HOLD)));
  });
});
