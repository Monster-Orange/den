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

const hookInput = (command) =>
  JSON.stringify({ tool_name: "Bash", tool_input: { command }, cwd: "/" });

export const SH_OUT_MAX = 1500;

export async function oneLine(a, cmd, ms) {
  if (/[\r\n]/.test(cmd))
    throw new Error(`refused a multi-line /sh command: ${cmd.slice(0, 80)}`);
  const r = await a.sh(cmd, ms);
  const text = String(r?.out ?? "");
  return {
    status: r?.status ?? null,
    out: text,
    cut: !!r?.cut || text.length >= SH_OUT_MAX,
  };
}

async function probe(a, dir, name, lines, ms = 20000) {
  const script = path.join(dir, `g974-${name}.sh`);
  const outFile = path.join(dir, `g974-${name}.out`);
  fs.rmSync(outFile, { force: true });
  fs.writeFileSync(script, lines.join("\n") + "\n");
  try {
    const r = await oneLine(a, `sh '${script}' > '${outFile}' 2>&1`, ms);
    if (r.status === null) return null;
    return fs.existsSync(outFile) ? fs.readFileSync(outFile, "utf-8") : null;
  } finally {
    fs.rmSync(script, { force: true });
    fs.rmSync(outFile, { force: true });
  }
}

export async function run(ctx, s) {
  const a = ctx.agent(s.id);
  const out = { ...s, unmeasured: [] };
  const miss = (what) => out.unmeasured.push(what);
  const env = await oneLine(a, "printenv CLAUDE_ENV_FILE", 15000);
  out.envFile = env.status === 0 && !env.cut ? env.out.trim() : null;
  if (!out.envFile || !fs.existsSync(out.envFile)) {
    miss(`CLAUDE_ENV_FILE (${out.envFile ?? "no answer"})`);
    out.turn = { ran: false, why: "no env file" };
    return out;
  }
  const dir = path.dirname(out.envFile);

  const names = await probe(a, dir, "names", [
    "env | sed -n 's/^\\([A-Za-z_][A-Za-z0-9_]*\\)=.*/\\1/p'",
  ]);
  if (names === null) miss("the session's variable names");
  out.heldNames =
    names === null
      ? null
      : names
          .split("\n")
          .map((n) => n.trim())
          .filter((n) => n && HELD.test(n) && !OWN.test(n));

  const text = fs.readFileSync(out.envFile, "utf-8");
  out.emptyList = /^# The list is empty/m.test(text);

  const prof = await probe(a, dir, "profile", [
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
  ]);
  const pm = /with=\[(.*)\] without=\[(.*)\]/.exec(prof ?? "");
  if (!pm) miss("the profile canary");
  out.withFile = pm ? pm[1] : null;
  out.withoutFile = pm ? pm[2] : null;

  out.hook = null;
  out.guard = {};
  let hooks = null;
  try {
    hooks = JSON.parse(
      fs.readFileSync(path.join(dir, "settings.json"), "utf-8"),
    ).hooks;
  } catch {
    miss("the agent's settings.json");
  }
  const cmd = (hooks?.PreToolUse ?? [])
    .filter((m) =>
      String(m.matcher ?? "")
        .split("|")
        .includes("Bash"),
    )
    .flatMap((m) => (m.hooks ?? []).map((h) => h.command))
    .find((c) => typeof c === "string" && c.includes("pretooluse.mjs"));
  if (hooks) out.hook = !!cmd;
  const node = /^'([^']+)'|^(\S+)/.exec(cmd ?? "");
  const nodeBin = node ? (node[1] ?? node[2]) : "node";
  if (cmd)
    for (const c of ["env", "printenv", "set"]) {
      const t = await probe(a, dir, `guard-${c}`, [
        `printf '%s' '${hookInput(c)}' | ${cmd} >"$TMPDIR/g974.json"; echo "exit=$?"`,
        `c=$('${nodeBin}' -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).hookSpecificOutput.updatedInput.command)' "$TMPDIR/g974.json" 2>/dev/null)`,
        `case "$c" in *env-mask.mjs*) echo masker=1 ;; *) echo masker=0 ;; esac`,
        `o=$(CANARY_TOKEN='${CANARY}' sh -c "$c" 2>&1)`,
        `case "$o" in *${CANARY}*) echo leak=1 ;; *) echo leak=0 ;; esac`,
        `case "$o" in *CANARY_TOKEN*) echo name=1 ;; *) echo name=0 ;; esac`,
        'rm -f "$TMPDIR/g974.json"',
      ]);
      if (t === null || !/exit=\d+/.test(t) || !/leak=[01]/.test(t)) {
        miss(`the ${c} guard`);
        continue;
      }
      out.guard[c] = {
        exit: Number(/exit=(\d+)/.exec(t)[1]),
        masker: /masker=1/.test(t),
        leak: /leak=1/.test(t),
        name: /name=1/.test(t),
      };
    }
  out.turn = out.emptyList
    ? { ran: false, why: "a personal install holds nothing back" }
    : await realTurn(out.envFile);
  return out;
}

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
  const r =
    (Array.isArray(cells) ? cells.find((c) => c?.result)?.result : cells) ?? {};
  const unmeasured = Array.isArray(r.unmeasured)
    ? r.unmeasured
    : ["every probe (no result)"];
  if (unmeasured.length)
    throw new Error(`974 not measured: ${unmeasured.join("; ")}`);
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
            `profile canary without the file: ${r.withoutFile === CANARY ? "seen" : "not seen"}, with it: ${r.withFile === "" ? "gone" : `still there ("${r.withFile}")`}`,
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
