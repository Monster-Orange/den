// gate/974.mjs: secret-looking variables are held out of agent sessions,
// and a command that prints the environment shows secret-looking values
// masked.
//
// A stub agent of its own on the bed (gate-974-<run>), started the way Den
// starts any agent. Inside its session (ctx.agent(id).sh):
//   - its environment's names (names only) hold nothing the default list
//     matches, Den's own aside;
//   - CLAUDE_ENV_FILE names Den's env-hold.sh in its files folder. A shell
//     whose profile exports a fake secret (CANARY) shows it without that
//     file and not with it (the order the runtime uses: profile, the file,
//     the command);
//   - the PreToolUse hook in its settings.json rewrites `env`, `printenv`
//     and `set` through Den's masker; each, run with a planted fake token,
//     shows the token's name and never its value.
// Then one real turn of the runtime's CLI on the host, when it is there
// and signed in (else that clause skips, needs-claude): the profile
// exports CANARY, the agent's env-hold.sh is named, and it runs
// `printenv CANARY_TOKEN`. Neither its answer nor its transcript holds
// CANARY. agents.env_allow is not set on the bed (a check never changes
// its config): its clause skips; the unit test proves it.
// Issue 1391: a personal install (the bed, unless it sets install_mode:
// strict) holds nothing back while agents.env_hold is unset. There the
// hold's clauses skip (needs-strict-install; the unit tests prove them),
// and the last clause checks the open default: Den's env-hold.sh holds
// nothing back but a person's credential, and the profile's CANARY passes.
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export const issue = 974;
export const clauses = [
  "an agent session starts without secret-looking variables, and its shell commands don't get them back from the profile",
  "a name agents.env_allow lists for the agent reaches it",
  "a bare env, printenv or set runs, with a planted fake token's name shown and its value masked",
  "a real agent turn with a fake secret in the profile: printenv prints nothing, and the transcript has no trace of it",
  "on a personal install with agents.env_hold unset, nothing is held back (the open default), and the guard still masks",
];
export const timeoutMs = 240000;

const CANARY = "canary-974-not-a-real-secret";
// The default list (agents/env-hold.ts), and the exact names Den sets for
// a launch (its actor, its actor token file, its install location, git's
// signing settings). Any other DEN_ or GIT_CONFIG_ name counts.
const HELD =
  /^(.*_TOKEN|.*_SECRET|.*_KEY|.*_PASSWORD|OP_SESSION_.*)(_[0-9].*)?$/i;
const OWN =
  /^(DEN_AGENT|DEN_ACTOR_TOKEN_FILE|DEN_ROOT|DEN_HOME|GIT_CONFIG_COUNT|GIT_CONFIG_KEY_[0-9]+|GIT_CONFIG_VALUE_[0-9]+)$/;

const fresh = () =>
  `gate-974-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

export async function setup(ctx) {
  const id = fresh();
  const a = ctx.agent(id);
  const start = a.start("tester");
  const runMs = await a.running(20000);
  return { id, startCode: start?.code ?? null, runMs };
}

/** A hook probe: the tool call as JSON into the PreToolUse command. */
const probe = (command) =>
  JSON.stringify({ tool_name: "Bash", tool_input: { command }, cwd: "/" });

export async function run(ctx, s) {
  const a = ctx.agent(s.id);
  const out = { ...s };
  const names = await a.sh(
    "env | sed -n 's/^\\([A-Za-z_][A-Za-z0-9_]*\\)=.*/\\1/p'",
    15000,
  );
  out.heldNames = String(names?.out ?? "")
    .split("\n")
    .map((n) => n.trim())
    .filter((n) => n && HELD.test(n) && !OWN.test(n));
  out.envFile = String(
    (await a.sh("printenv CLAUDE_ENV_FILE", 15000))?.out ?? "",
  ).trim();
  out.emptyList = /\b1\b/.test(
    String(
      (
        await a.sh(
          'grep -c "^# The list is empty" "$CLAUDE_ENV_FILE" 2>/dev/null',
          15000,
        )
      )?.out ?? "",
    ),
  );

  // Profile, then Den's file, then the command; and without the file.
  const prof = await a.sh(
    [
      "d=$(mktemp -d)",
      `printf 'export CANARY_TOKEN=%s\\n' '${CANARY}' > "$d/.zshenv"`,
      'cp "$d/.zshenv" "$d/profile.sh"',
      "if command -v zsh >/dev/null 2>&1; then",
      '  w=$(ZDOTDIR="$d" zsh -c \'. "$CLAUDE_ENV_FILE"; printenv CANARY_TOKEN\')',
      "  wo=$(ZDOTDIR=\"$d\" zsh -c 'printenv CANARY_TOKEN')",
      "else",
      '  w=$(sh -c \'. "$1/profile.sh"; . "$CLAUDE_ENV_FILE"; printenv CANARY_TOKEN\' _ "$d")',
      '  wo=$(sh -c \'. "$1/profile.sh"; printenv CANARY_TOKEN\' _ "$d")',
      "fi",
      'rm -rf "$d"',
      'echo "with=[$w] without=[$wo]"',
    ].join("\n"),
    20000,
  );
  const pm = /with=\[(.*)\] without=\[(.*)\]/.exec(String(prof?.out ?? ""));
  out.withFile = pm ? pm[1] : null;
  out.withoutFile = pm ? pm[2] : null;

  // The PreToolUse hook Den gave this agent.
  out.hook = null;
  out.guard = {};
  if (out.envFile) {
    const set = await a.sh(
      'cat "$(dirname "$CLAUDE_ENV_FILE")/settings.json"',
      15000,
    );
    let hooks = null;
    try {
      hooks = JSON.parse(String(set?.out ?? "")).hooks;
    } catch {
      hooks = null;
    }
    const cmd = (hooks?.PreToolUse ?? [])
      .filter((m) =>
        String(m.matcher ?? "")
          .split("|")
          .includes("Bash"),
      )
      .flatMap((m) => (m.hooks ?? []).map((h) => h.command))
      .find((c) => typeof c === "string" && c.includes("pretooluse.mjs"));
    out.hook = cmd ? true : false;
    // The hook's node: the first word of its command.
    const node = /^'([^']+)'|^(\S+)/.exec(cmd ?? "");
    const nodeBin = node ? (node[1] ?? node[2]) : "node";
    if (cmd)
      for (const c of ["env", "printenv", "set"]) {
        const r = await a.sh(
          [
            `printf '%s' '${probe(c)}' | ${cmd} >"$TMPDIR/g974.json"; echo "exit=$?"`,
            `c=$('${nodeBin}' -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).hookSpecificOutput.updatedInput.command)' "$TMPDIR/g974.json" 2>/dev/null)`,
            `case "$c" in *env-mask.mjs*) echo masker=1 ;; *) echo masker=0 ;; esac`,
            `o=$(CANARY_TOKEN='${CANARY}' sh -c "$c" 2>&1)`,
            `case "$o" in *${CANARY}*) echo leak=1 ;; *) echo leak=0 ;; esac`,
            `case "$o" in *CANARY_TOKEN*) echo name=1 ;; *) echo name=0 ;; esac`,
            'rm -f "$TMPDIR/g974.json"',
          ].join("\n"),
          20000,
        );
        const t = String(r?.out ?? "");
        out.guard[c] = {
          exit: Number(/exit=(\d+)/.exec(t)?.[1] ?? NaN),
          masker: /masker=1/.test(t),
          leak: !/leak=0/.test(t),
          name: /name=1/.test(t),
        };
      }
  }

  // One real turn of the runtime's CLI, when it is here and signed in.
  out.turn = out.emptyList
    ? { ran: false, why: "a personal install holds nothing back" }
    : await realTurn(out.envFile);
  return out;
}

/** A real CLI turn: profile with CANARY, the agent's env file, printenv. */
async function realTurn(envFile) {
  if (!envFile || !fs.existsSync(envFile))
    return { ran: false, why: "no env file" };
  let claude = "";
  try {
    claude = execFileSync("sh", ["-c", "command -v claude"], {
      encoding: "utf-8",
    }).trim();
  } catch {
    return { ran: false, why: "no claude" };
  }
  if (!claude) return { ran: false, why: "no claude" };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gate974-"));
  try {
    const zdot = path.join(dir, "zdot");
    const cwd = path.join(dir, "cwd");
    fs.mkdirSync(zdot);
    fs.mkdirSync(cwd);
    fs.writeFileSync(
      path.join(zdot, ".zshenv"),
      `export CANARY_TOKEN=${CANARY}\n`,
    );
    let text = "";
    try {
      text = execFileSync(
        claude,
        [
          "-p",
          "--model",
          "haiku",
          "--allowedTools",
          "Bash",
          "--output-format",
          "json",
          "Run exactly this shell command with the Bash tool, then reply with its output verbatim: printenv CANARY_TOKEN; echo end-974",
        ],
        {
          cwd,
          encoding: "utf-8",
          timeout: 150000,
          env: {
            PATH: process.env.PATH ?? "/usr/bin:/bin",
            HOME: process.env.HOME ?? "",
            USER: process.env.USER ?? "",
            SHELL: fs.existsSync("/bin/zsh") ? "/bin/zsh" : "/bin/sh",
            TERM: "xterm-256color",
            ZDOTDIR: zdot,
            CLAUDE_ENV_FILE: envFile,
          },
        },
      );
    } catch {
      return { ran: false, why: "claude did not answer (not signed in?)" };
    }
    let o = null;
    try {
      o = JSON.parse(text);
    } catch {
      o = null;
    }
    if (!o || o.is_error) return { ran: false, why: "claude did not answer" };
    const sid = String(o.session_id ?? "");
    const root = path.join(process.env.HOME ?? "", ".claude", "projects");
    let transcript = null;
    try {
      for (const p of fs.readdirSync(root)) {
        const f = path.join(root, p, `${sid}.jsonl`);
        if (sid && fs.existsSync(f)) transcript = f;
      }
    } catch {
      transcript = null;
    }
    const tr = transcript ? fs.readFileSync(transcript, "utf-8") : null;
    const ran =
      /end-974/.test(String(o.result ?? "")) || (tr ?? "").includes("end-974");
    return {
      ran,
      why: ran ? "" : "the command did not run",
      answerHas: text.includes(CANARY),
      transcript: tr !== null,
      transcriptHas: tr !== null && tr.includes(CANARY),
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export async function teardown(ctx, s) {
  if (s?.id && ctx.agent(s.id).state()) ctx.agent(s.id).remove();
}

export function expect(cells) {
  const r = cells.find((c) => c?.result)?.result ?? {};
  const fileOk = !!r.envFile && path.basename(r.envFile) === "env-hold.sh";
  const g = r.guard ?? {};
  const masked = ["env", "printenv", "set"].every(
    (c) => g[c]?.exit === 0 && g[c]?.masker && !g[c]?.leak && g[c]?.name,
  );
  const t = r.turn ?? {};
  const open = r.emptyList === true;
  const strictOnly = (clause) => ({
    clause,
    ok: null,
    skip: "needs-strict-install",
    detail:
      "the bed is a personal install with agents.env_hold unset: nothing is held back there; tests/unit/agents/env-hold.test.ts proves the hold",
  });
  const guardOk = r.hook === true && masked;
  return [
    open
      ? strictOnly(clauses[0])
      : {
          clause: clauses[0],
          ok:
            (r.heldNames ?? []).length === 0 &&
            fileOk &&
            r.withoutFile === CANARY &&
            r.withFile === "",
          detail:
            `held-looking names in the session: ${(r.heldNames ?? []).length ? (r.heldNames ?? []).join(", ") : "none"}; ` +
            `CLAUDE_ENV_FILE ${fileOk ? "names env-hold.sh" : `is "${r.envFile}"`}; ` +
            `profile canary without the file: ${r.withoutFile === CANARY ? "seen" : "not seen"}, with it: ${r.withFile === "" ? "gone" : "still there"}`,
        },
    {
      clause: clauses[1],
      ok: null,
      skip: "needs-config-change",
      detail:
        "a check never sets agents.env_allow on the bed; tests/unit/agents/env-hold.test.ts proves it",
    },
    {
      clause: clauses[2],
      ok: guardOk,
      detail: r.hook
        ? Object.entries(g)
            .map(
              ([c, v]) =>
                `${c}: exit ${v.exit}, ${v.masker ? "masked" : "not rewritten"}, name ${v.name ? "shown" : "missing"}, value ${v.leak ? "SEEN" : "never seen"}`,
            )
            .join("; ")
        : "no PreToolUse hook with pretooluse.mjs in the agent's settings.json",
    },
    open
      ? strictOnly(clauses[3])
      : t.ran
        ? {
            clause: clauses[3],
            ok: !t.answerHas && t.transcript && !t.transcriptHas,
            detail: `answer has the canary: ${t.answerHas}; transcript found: ${t.transcript}; transcript has the canary: ${t.transcriptHas}`,
          }
        : {
            clause: clauses[3],
            ok: null,
            skip: "needs-claude",
            detail: t.why || "no real CLI turn",
          },
    open
      ? {
          clause: clauses[4],
          ok: fileOk && r.withFile === CANARY && guardOk,
          detail: `CLAUDE_ENV_FILE ${fileOk ? "names env-hold.sh" : `is "${r.envFile}"`} and says the list is empty; profile canary with it: ${r.withFile === CANARY ? "passes (nothing held)" : "gone"}; guard ${guardOk ? "masks" : "doesn't mask"}`,
        }
      : {
          clause: clauses[4],
          ok: null,
          skip: "needs-personal-install",
          detail:
            "the bed holds secret-looking variables back (install_mode: strict, or agents.env_hold set)",
        },
  ];
}
