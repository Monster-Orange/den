/**
 * Issue 790: a cpu check (unit tests, lint, pre-checks) run on a test box
 * over ssh, in the box's own cpu slot.
 *
 * Only three things leave this machine: the tree, the arguments and an
 * allowed environment. This machine's environment never goes: the remote
 * command starts with `env -i`, given the box's own HOME and PATH, CI,
 * the slot's variables and the names asked for with --env. A run is
 * refused on a box (it can run here with --box local) when an argument
 * or an --env value is a store reference or a token, an --env name looks
 * secret, the command is a secret store's own program, or an untracked
 * file it would ship holds a secret. A refusal names the place (the
 * argument's number, the --env name, the file), never the value.
 *
 * On the box, under ~/.den-gate:
 *   runs/<id>/tree   the shipped tree (removed when the run ends)
 *   runs/<id>/pid    the run's process (its group, where setsid exists)
 *   deps/<sha>       node_modules for one package-lock.json (its sha256):
 *                    installed in a temp folder, moved in only when npm ci
 *                    worked, then made read-only, so no run can change
 *                    what the next one loads
 * Every name put into a remote path is checked first (boxRunIdOk), and
 * every argument is quoted alone (shQuote): the remote shell parses the
 * command once, and nothing in it is pasted unquoted.
 */
import { spawn as nodeSpawn } from "child_process";
import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { redactSecrets, SECRET_PATTERNS, STORE_REF } from "../redact.js";
import type { GateBox } from "./boxes.js";

/** The folder under the box's HOME that box runs use. */
export const BOX_RUN_ROOT = ".den-gate";

/** An untracked file larger than this isn't scanned, so isn't shipped. */
export const SHIP_SCAN_MAX_BYTES = 1024 * 1024;

const RUN_ID = /^[A-Za-z0-9._-]{1,80}$/;
/** A name safe in a remote path: never "." or "..", never a slash. */
export function boxRunIdOk(id: string): boolean {
  return RUN_ID.test(id) && id !== "." && id !== "..";
}
const LOCK_SHA = /^[0-9a-f]{64}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function mustId(id: string): string {
  if (!boxRunIdOk(id))
    throw new Error(
      "a box run's id is letters, digits, dot, dash or underscore (at most 80)",
    );
  return id;
}

/** One shell word, single-quoted: the shell reads it back as it was. */
export function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** A secret store's reference, or a value shaped like a secret. */
function looksSecret(text: string): boolean {
  if (new RegExp(STORE_REF.source, "i").test(text)) return true;
  if (/\bkeychain:[^\s]/i.test(text)) return true;
  return redactSecrets(text) !== text;
}

/**
 * A file's text holds a secret: a store reference, a value shaped like a
 * secret (a token, a key block, a URL with a password), or a dumped
 * secret variable (GITHUB_TOKEN=…). Not the log redactor's broad
 * name: value match, which a lockfile trips ("js-tokens": "^4.0.0").
 */
function fileLooksSecret(text: string): boolean {
  if (new RegExp(STORE_REF.source, "i").test(text)) return true;
  for (const p of SECRET_PATTERNS) {
    if (p.name === "key=value secret") continue;
    if (new RegExp(p.re.source, p.re.flags.replace("g", "")).test(text))
      return true;
  }
  return SECRET_ENV_LINE.test(text);
}
const SECRET_ENV_LINE =
  /^\s*(?:export\s+)?[A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE_?KEY|ACCESS_?KEY|CREDENTIAL)[A-Za-z0-9_]*\s*=\s*["']?[^\s"']{8,}/im;

/** Names whose value is a secret. */
const SECRET_NAME =
  /(TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|API_?KEY|PRIVATE_?KEY|ACCESS_?KEY|CREDENTIAL|_AUTH\b|^AUTH)/i;
/** A command that reads a secret variable by name: $GH_TOKEN, ${..._KEY}. */
const SECRET_VAR_USE =
  /\$\{?[A-Za-z_][A-Za-z0-9_]*(TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE_?KEY|ACCESS_?KEY|CREDENTIAL)[A-Za-z0-9_]*\}?/i;
/** A secret store's own program (it would ask this machine's store). */
const STORE_PROGRAMS = new Set([
  "op",
  "security",
  "doppler",
  "bws",
  "infisical",
  "vault",
]);

const local = "It can run on this machine instead: --box local.";

/** The box's own variables, and the gate's: never sent with --env. */
const RESERVED_ENV =
  /^(HOME|PATH|CI|USER|LOGNAME|SHELL|PWD|TMPDIR|IFS|ENV|BASH_ENV)$|^(GATE_|DEN_GATE_|LD_|DYLD_)/;

/**
 * Why `args` (the command and its arguments) and `env` (the --env names,
 * with this machine's values) can't go to a box, or null when they can.
 */
export function boxSecretRefusal(
  args: readonly string[],
  env: Readonly<Record<string, string>>,
): string | null {
  const prog = path.basename(args[0] ?? "");
  if (STORE_PROGRAMS.has(prog) || (prog === "gh" && args[1] === "auth"))
    return `argument 1 is a secret store's program, which reads this machine's secrets: it doesn't run on a test box. ${local}`;
  for (let i = 0; i < args.length; i++)
    if (looksSecret(args[i]!) || SECRET_VAR_USE.test(args[i]!))
      return `argument ${i + 1} holds or names a secret (a store reference, a token or a secret variable): secrets never leave this machine. ${local}`;
  for (const [k, v] of Object.entries(env)) {
    if (!ENV_NAME.test(k)) return `--env ${JSON.stringify(k)} isn't a name.`;
    if (RESERVED_ENV.test(k))
      return `--env ${k} is the box's own or the gate's: it isn't sent from this machine.`;
    if (SECRET_NAME.test(k) || looksSecret(v))
      return `--env ${k} is, or holds, a secret: secrets never leave this machine. ${local}`;
  }
  return null;
}

/** Files that are never shipped, by name or folder. */
const DENY_BASE =
  /^(\.env(\..*)?|\.dev\.vars|\.netrc|\.git-credentials|\.npmrc|\.pypirc|\.yarnrc(\.yml)?|credentials([-_.].*)?|.*[-_.]credentials(\..*)?|settings\.local\.json|id_[a-z0-9_-]+(\.pub)?)$/;
const DENY_EXT = /\.(pem|key|p12|pfx|kdbx|tfvars|keystore|jks|ppk|age)$/;
const DENY_DIR = new Set([
  ".aws",
  ".ssh",
  ".gnupg",
  ".docker",
  ".den",
  "secrets",
]);

function denied(f: string): boolean {
  // Lowercased: Secrets/ and .ENV are the same as secrets/ and .env.
  const parts = f.toLowerCase().split("/");
  const base = parts[parts.length - 1]!;
  return (
    DENY_BASE.test(base) ||
    DENY_EXT.test(base) ||
    parts.slice(0, -1).some((p) => DENY_DIR.has(p)) ||
    /[\n\r\0]/.test(f)
  );
}

export interface ShipPlan {
  /** Paths shipped, relative to the tree's root. */
  ship: string[];
  /** Left out by name (a secret file). */
  left: string[];
  /** Submodules (gitlinks): left out whole, never shipped unscanned. */
  submodules: string[];
  /** Untracked files too large, or binary, to scan: not shipped. */
  skipped: string[];
  /** Why the run is refused, when it is. */
  refused?: string;
}

/**
 * What ships from `files` (the tree's tracked and untracked files).
 * `scan` (untracked files, and tracked ones with uncommitted changes) is
 * read and scanned: what isn't committed is where a pasted token is
 * likeliest. Committed contents are already in git. A submodule
 * (`gitlinks`) is left out whole: tar would ship its files unscanned.
 */
export function shipPlan(
  files: readonly string[],
  scan: ReadonlySet<string>,
  read: (f: string) => Buffer | null,
  gitlinks: ReadonlySet<string> = new Set(),
): ShipPlan {
  const p: ShipPlan = { ship: [], left: [], submodules: [], skipped: [] };
  for (const f of files) {
    if (gitlinks.has(f)) {
      p.submodules.push(f);
      continue;
    }
    if (denied(f)) {
      p.left.push(f);
      continue;
    }
    if (scan.has(f)) {
      const b = read(f);
      if (!b) continue;
      if (b.length > SHIP_SCAN_MAX_BYTES || b.subarray(0, 8192).includes(0)) {
        p.skipped.push(f);
        continue;
      }
      if (fileLooksSecret(b.toString("utf-8"))) {
        p.refused = `${f} (not committed) holds something shaped like a secret, so the tree can't go to a test box. Remove it, or ${local.charAt(0).toLowerCase()}${local.slice(1)}`;
        return p;
      }
    }
    p.ship.push(f);
  }
  if (!p.ship.includes("package-lock.json"))
    p.refused = `No package-lock.json at the tree's root: a test box installs only from a lockfile. ${local}`;
  return p;
}

const ROOT = `"$HOME/${BOX_RUN_ROOT}"`;

/**
 * Installs node_modules for the lockfile in the current folder (the run's
 * tree) once per box, read-only, and gives the run its own copy (a clone
 * where the file system has one), so what the run writes never reaches
 * the cache. The run is the same box user as the cache's owner, so code
 * set on it could still reach the cache's folder; only a separate cache
 * user would stop that (not done here).
 */
export function depsScript(lockSha: string): string {
  if (!LOCK_SHA.test(lockSha)) throw new Error("a lockfile id is its sha256");
  return [
    "set -e",
    // A box's non-login shell may lack node (installed for logins only).
    `command -v npm >/dev/null 2>&1 || { echo "den gate: npm isn't on this test box's PATH for ssh commands: install Node.js there, or put it on that PATH" >&2; exit 127; }`,
    `D=${ROOT}/deps; F="$D/${lockSha}"; mkdir -p "$D"`,
    'if [ ! -d "$F" ]; then',
    '  L="$F.lock"; n=0',
    '  until mkdir "$L" 2>/dev/null; do',
    '    if [ -n "$(find "$L" -maxdepth 0 -mmin +30 2>/dev/null)" ]; then rm -rf "$L"; continue; fi',
    '    n=$((n+1)); if [ "$n" -gt 900 ]; then echo "den gate: another install of these dependencies is still running on this box" >&2; exit 1; fi',
    "    sleep 2",
    "  done",
    '  T="$F.tmp.$$"',
    `  trap 'rm -rf "$L"; if [ -d "$T" ]; then chmod -R u+w "$T" 2>/dev/null; rm -rf "$T"; fi' EXIT`,
    '  if [ ! -d "$F" ]; then',
    '    mkdir "$T"; cp package.json package-lock.json "$T/"',
    '    (cd "$T" && npm ci --no-audit --no-fund) >&2',
    '    chmod -R a-w "$T"',
    '    mv "$T" "$F"',
    "  fi",
    "fi",
    'touch "$F" 2>/dev/null || true',
    "rm -rf node_modules",
    'if cp -a --reflink=auto "$F/node_modules" node_modules 2>/dev/null; then :; else rm -rf node_modules; if cp -c -R -p "$F/node_modules" node_modules 2>/dev/null; then :; else rm -rf node_modules; cp -R -p "$F/node_modules" node_modules; fi; fi',
    "chmod -R u+w node_modules",
  ].join("\n");
}

/**
 * Runs `argv` in the run's tree with only the box's own HOME and PATH and
 * `env`. Its process number goes to runs/<id>/pid; with setsid it leads
 * its own group, so stopping it stops what it started.
 */
export function runScript(
  id: string,
  argv: readonly string[],
  env: Readonly<Record<string, string>>,
  sub = "",
): string {
  mustId(id);
  if (!argv.length) throw new Error("a box run needs a command");
  for (const k of Object.keys(env))
    if (!ENV_NAME.test(k)) throw new Error(`not an environment name: ${k}`);
  if (
    sub &&
    (sub.split("/").some((p) => p === ".." || p === "") || sub.startsWith("/"))
  )
    throw new Error("the run's folder is inside its tree");
  const dir = `${ROOT}/runs/${id}`;
  const vars = Object.entries(env).map(([k, v]) => shQuote(`${k}=${v}`));
  return [
    `cd ${dir}/tree${sub ? `/${shQuote(sub)}` : ""} || exit 125`,
    'if command -v setsid >/dev/null 2>&1 && setsid -w true 2>/dev/null; then S="setsid -w"; else S=""; fi',
    `exec $S env -i ${vars.join(" ")} HOME="$HOME" PATH="$PATH" sh -c 'echo $$ > "$0"; exec "$@"' ${dir}/pid ${argv.map(shQuote).join(" ")}`,
  ].join("\n");
}

/** Stops one run's process (its group first), as a shell snippet. */
const stopPid = (pidFile: string) =>
  [
    // A pid of 1 or less is never a group: kill -1 is every process.
    `if [ -f ${pidFile} ]; then p=$(cat ${pidFile}); case "$p" in ''|*[!0-9]*) ;; *) if [ "$p" -gt 1 ]; then`,
    '  kill -TERM -"$p" 2>/dev/null || kill -TERM "$p" 2>/dev/null || true',
    "  sleep 1",
    '  kill -KILL -"$p" 2>/dev/null || kill -KILL "$p" 2>/dev/null || true; fi;;',
    "esac; fi",
  ].join("\n");

/** Stops run `id` on the box (gate run got a signal). */
export function stopScript(id: string): string {
  return stopPid(`${ROOT}/runs/${mustId(id)}/pid`);
}

/** Removes run `id`'s folder (always, when the run ends). */
export function cleanScript(id: string): string {
  return `rm -rf -- ${ROOT}/runs/${mustId(id)}`;
}

const TAG = /^[A-Za-z0-9_-]{1,40}$/;

/**
 * A box run's folder name: this install's tag (its slot store's), a dot,
 * the slot's id. Two installs sharing a box each sweep only their own.
 */
export function boxRunName(tag: string, slot: string): string {
  if (!TAG.test(tag) || !boxRunIdOk(slot))
    throw new Error("a box run's tag or slot id can't go in a path");
  return `${tag}.${slot}`;
}

/**
 * At each box run's start: every run folder of this install (`tag`)
 * whose slot is no longer granted (`live`: its granted runs' folder
 * names) is stopped and removed, left by a dropped ssh. Another
 * install's runs are never touched. Dependencies unused for 7 days, and
 * leftover temp installs, go too.
 */
export function sweepScript(tag: string, live: readonly string[]): string {
  if (!TAG.test(tag)) throw new Error("an install's tag can't go in a path");
  for (const id of live) mustId(id);
  return [
    `R=${ROOT}/runs`,
    `if [ -d "$R" ]; then for d in "$R"/${tag}.*; do`,
    '  [ -d "$d" ] || continue',
    "  n=${d##*/}",
    `  case " ${live.join(" ")} " in *" $n "*) continue;; esac`,
    stopPid('"$d/pid"')
      .split("\n")
      .map((l) => `  ${l}`)
      .join("\n"),
    '  rm -rf -- "$d"',
    "done; fi",
    `D=${ROOT}/deps`,
    'if [ -d "$D" ]; then',
    '  find "$D" -mindepth 1 -maxdepth 1 \\( -name "*.tmp.*" -mmin +1440 -o -type d ! -name "*.*" -mtime +7 \\) -print 2>/dev/null | while read -r x; do chmod -R u+w "$x" 2>/dev/null; rm -rf -- "$x"; done',
    "fi",
    // Never `exit`: the ship script goes on after the sweep.
    ":",
  ].join("\n");
}

/** The sweep, then the tree (a tar on stdin) unpacked into run `id`. */
export function shipScript(
  id: string,
  tag: string,
  live: readonly string[],
): string {
  const dir = `${ROOT}/runs/${mustId(id)}/tree`;
  return `${sweepScript(tag, live)}\nmkdir -p ${dir} && tar -xf - -C ${dir}`;
}

/** ssh's arguments for `box` (keys only), as the box check uses them. */
export function boxSshArgs(box: GateBox, connectSecs = 15): string[] {
  if (!box.ssh) throw new Error(`box ${box.name} has no ssh`);
  return [
    "-T",
    "-o",
    "BatchMode=yes",
    // Nothing of this machine's rides along: not its ssh agent, its X
    // display, a port forward, a local command or a variable.
    "-o",
    "ForwardAgent=no",
    "-o",
    "ForwardX11=no",
    "-o",
    "ClearAllForwardings=yes",
    "-o",
    "PermitLocalCommand=no",
    "-o",
    "ControlMaster=no",
    "-o",
    "ControlPath=none",
    // ssh keeps the first SetEnv it reads: ours, not one in ssh_config.
    // SendEnv can't be cleared from here (a config's list still applies),
    // so ssh is started with a small environment (sshEnv): what a
    // config's SendEnv names isn't there to send.
    "-o",
    "SetEnv=DEN_GATE_BOX_RUN=1",
    "-o",
    "SendEnv=-*",
    "-o",
    `ConnectTimeout=${connectSecs}`,
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=4",
    ...(box.ssh_port ? ["-p", String(box.ssh_port)] : []),
    ...(box.ssh_identity ? ["-i", box.ssh_identity] : []),
    "--",
    box.ssh,
  ];
}

/** What ssh itself may see of this machine's environment. */
const SSH_ENV = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SSH_AUTH_SOCK",
  "LANG",
  "TERM",
];

/** A small environment for ssh (its own key's agent, its locale). */
export function sshEnv(
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const k of SSH_ENV) if (env[k] !== undefined) out[k] = env[k];
  return out;
}

/** The tree a run ships: git's files under its top folder. */
export interface BoxTree {
  root: string;
  /** The run's folder inside it ("" for the root). */
  sub: string;
  files: string[];
  untracked: Set<string>;
  /** Issue 790: tracked files with uncommitted changes (staged or not). */
  changed: Set<string>;
  /** Submodules (mode 160000): never shipped. */
  gitlinks: Set<string>;
}

/** What a box run scans: untracked files and uncommitted changes. */
export const scanSet = (t: BoxTree): Set<string> =>
  new Set([...t.untracked, ...t.changed]);

/** The tree for `cwd`, from git (tracked plus untracked, not ignored). */
export function gitTree(cwd: string, git: (args: string[]) => string): BoxTree {
  const root = git(["rev-parse", "--show-toplevel"]).trim();
  const sub = path
    .relative(root, fs.realpathSync(cwd))
    .split(path.sep)
    .join("/");
  const z = (s: string) => s.split("\0").filter(Boolean);
  const files = z(
    git(["-C", root, "ls-files", "-co", "--exclude-standard", "-z"]),
  );
  const untracked = new Set(
    z(git(["-C", root, "ls-files", "-o", "--exclude-standard", "-z"])),
  );
  // No commit yet: nothing is committed, so every file is scanned.
  let changed: Set<string>;
  try {
    changed = new Set(
      z(git(["-C", root, "diff", "--name-only", "-z", "HEAD", "--"])),
    );
  } catch {
    changed = new Set(files);
  }
  const gitlinks = new Set(
    z(git(["-C", root, "ls-files", "-s", "-z"]))
      .filter((l) => l.startsWith("160000 "))
      .map((l) => l.slice(l.indexOf("\t") + 1)),
  );
  return { root, sub, files, untracked, changed, gitlinks };
}

export interface BoxCpuRun {
  /** The run's folder name on the box (boxRunName: tag.slot). */
  id: string;
  /** This install's tag: its sweep touches only its own runs. */
  tag: string;
  argv: string[];
  /** The gate's own variables: CI and the slot's. */
  env: Record<string, string>;
  /** The --env names with this machine's values: checked. */
  pass: Record<string, string>;
  tree: BoxTree;
  /** This install's granted runs on the box (folder names), kept. */
  live: string[];
}

export interface BoxCpuDeps {
  spawn?: typeof nodeSpawn;
  readFile?: (f: string) => Buffer | null;
  out?: (b: Buffer) => void;
  err?: (b: Buffer) => void;
  /** A line for the person (left-out files, refusals). */
  say?: (line: string) => void;
}

/** What starting a box run gives: a refusal, or the running command. */
export type BoxCpuStart =
  | { ok: false; error: string }
  | {
      ok: true;
      kill: (s: NodeJS.Signals) => void;
      /** The exit code; 255 only when the box couldn't be reached. */
      done: Promise<number>;
    };

/**
 * Ships the tree, installs its dependencies, runs the command with its
 * output streamed here, and removes the run's folder when it ends (also
 * after a failure or a signal).
 */
export function startBoxCpuRun(
  box: GateBox,
  r: BoxCpuRun,
  d: BoxCpuDeps = {},
): BoxCpuStart {
  if (!boxRunIdOk(r.id))
    return { ok: false, error: "the run's id can't go in a path on a box" };
  if (!box.ssh)
    return {
      ok: false,
      error: `box ${box.name} has no ssh: cpu runs need one`,
    };
  // Only what comes from this machine is checked: the gate's own
  // variables are given by name, never matched by a prefix.
  const refusedArgs = boxSecretRefusal(r.argv, r.pass);
  if (refusedArgs) return { ok: false, error: refusedArgs };
  const read =
    d.readFile ??
    ((f: string) => {
      try {
        return fs.readFileSync(path.join(r.tree.root, f));
      } catch {
        return null;
      }
    });
  const plan = shipPlan(r.tree.files, scanSet(r.tree), read, r.tree.gitlinks);
  if (plan.refused) return { ok: false, error: plan.refused };
  const lock = read("package-lock.json");
  if (!lock)
    return {
      ok: false,
      error: `No package-lock.json at the tree's root. ${local}`,
    };
  const sha = createHash("sha256").update(lock).digest("hex");
  const say = d.say ?? (() => {});
  if (plan.submodules.length)
    say(`Not shipped (submodules): ${plan.submodules.join(", ")}`);
  if (plan.left.length)
    say(`Not shipped (secret files): ${plan.left.join(", ")}`);
  if (plan.skipped.length)
    say(
      `Not shipped (untracked, binary or over 1 MB, not scanned): ${plan.skipped.join(", ")}`,
    );
  const sp = d.spawn ?? nodeSpawn;
  const ssh = boxSshArgs(box);
  const out = d.out ?? ((b: Buffer) => void process.stdout.write(b));
  const err = d.err ?? ((b: Buffer) => void process.stderr.write(b));
  let stopped = false;
  let running: ReturnType<typeof nodeSpawn> | null = null;

  const remote = (
    script: string,
    o: { stdin?: NodeJS.ReadableStream; stream?: boolean } = {},
  ) =>
    new Promise<{ code: number; saw: boolean }>((resolve) => {
      const k = sp("ssh", [...ssh, script], {
        stdio: [o.stdin ? "pipe" : "ignore", "pipe", "pipe"],
        env: sshEnv(),
      });
      running = k;
      let saw = false;
      k.stdout?.on("data", (b: Buffer) => {
        saw = true;
        if (o.stream) out(b);
      });
      k.stderr?.on("data", (b: Buffer) => {
        saw = true;
        err(b);
      });
      if (o.stdin && k.stdin) o.stdin.pipe(k.stdin);
      k.on("error", () => resolve({ code: 127, saw }));
      k.on("close", (code, sig) => {
        if (running === k) running = null;
        resolve({ code: code ?? (sig ? 128 : 1), saw });
      });
    });

  const unreachable = () => {
    say(`Test box ${box.name} couldn't be reached over ssh.`);
    return 255;
  };

  const done = (async (): Promise<number> => {
    try {
      // --no-recursion: only the listed files, never a folder's contents.
      const tar = sp(
        "tar",
        ["-cf", "-", "--no-recursion", "--null", "-T", "-"],
        {
          cwd: r.tree.root,
          stdio: ["pipe", "pipe", "inherit"],
          env: {
            PATH: process.env.PATH ?? "/usr/bin:/bin",
            COPYFILE_DISABLE: "1",
          },
        },
      );
      tar.stdin?.end(plan.ship.join("\0") + "\0");
      const dir = `${ROOT}/runs/${r.id}/tree`;
      const ship = await remote(shipScript(r.id, r.tag, r.live), {
        stdin: tar.stdout!,
      });
      if (stopped) return 130;
      if (ship.code === 255 && !ship.saw) return unreachable();
      if (ship.code !== 0) {
        say(`Shipping the tree to ${box.name} failed (exit ${ship.code}).`);
        return ship.code;
      }
      const deps = await remote(`cd ${dir} || exit 125\n${depsScript(sha)}`);
      if (stopped) return 130;
      if (deps.code === 255 && !deps.saw) return unreachable();
      if (deps.code !== 0) {
        // 127: the box said why (no npm); else the install itself failed.
        if (deps.code !== 127)
          say(
            `npm ci on ${box.name} failed (exit ${deps.code}). A lockfile that needs a signed-in registry can't install on a box. ${local}`,
          );
        return deps.code;
      }
      const run = await remote(
        runScript(r.id, r.argv, { ...r.pass, ...r.env }, r.tree.sub),
        {
          stream: true,
        },
      );
      if (run.code === 255 && !run.saw) return unreachable();
      return run.code;
    } finally {
      await new Promise<void>((res) => {
        const k = sp("ssh", [...ssh, cleanScript(r.id)], {
          stdio: "ignore",
          env: sshEnv(),
        });
        k.on("error", () => res());
        k.on("close", () => res());
      });
    }
  })();

  return {
    ok: true,
    done,
    kill: (s) => {
      if (stopped && s !== "SIGKILL") return;
      stopped = true;
      const k = sp("ssh", [...boxSshArgs(box, 10), stopScript(r.id)], {
        stdio: "ignore",
        env: sshEnv(),
      });
      k.on("error", () => {});
      if (s === "SIGKILL" && running)
        (running as ReturnType<typeof nodeSpawn>).kill("SIGKILL");
    },
  };
}
