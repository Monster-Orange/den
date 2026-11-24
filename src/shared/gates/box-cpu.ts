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
import { redactSecrets, STORE_REF } from "../redact.js";
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
    if (SECRET_NAME.test(k) || looksSecret(v))
      return `--env ${k} is, or holds, a secret: secrets never leave this machine. ${local}`;
  }
  return null;
}

/** Files that are never shipped, by name or folder. */
const DENY_BASE =
  /^(\.env(\..*)?|\.dev\.vars|\.netrc|\.git-credentials|\.npmrc|\.pypirc|\.yarnrc(\.yml)?|credentials.*\.json|settings\.local\.json|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?)$/i;
const DENY_EXT = /\.(pem|key|p12|pfx|kdbx|tfvars|keystore|jks|ppk|age)$/i;
const DENY_DIR = new Set([".aws", ".ssh", ".gnupg", ".docker", "secrets"]);

function denied(f: string): boolean {
  const parts = f.split("/");
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
  /** Untracked files too large, or binary, to scan: not shipped. */
  skipped: string[];
  /** Why the run is refused, when it is. */
  refused?: string;
}

/**
 * What ships from `files` (the tree's tracked and untracked files).
 * Untracked ones are read and scanned: a new, uncommitted file is where
 * a pasted token is likeliest. Tracked files are already in git.
 */
export function shipPlan(
  files: readonly string[],
  untracked: ReadonlySet<string>,
  read: (f: string) => Buffer | null,
): ShipPlan {
  const p: ShipPlan = { ship: [], left: [], skipped: [] };
  for (const f of files) {
    if (denied(f)) {
      p.left.push(f);
      continue;
    }
    if (untracked.has(f)) {
      const b = read(f);
      if (!b) continue;
      if (b.length > SHIP_SCAN_MAX_BYTES || b.subarray(0, 8192).includes(0)) {
        p.skipped.push(f);
        continue;
      }
      if (looksSecret(b.toString("utf-8"))) {
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
 * tree) once per box, read-only, and links it in. Run in the tree.
 */
export function depsScript(lockSha: string): string {
  if (!LOCK_SHA.test(lockSha)) throw new Error("a lockfile id is its sha256");
  return [
    "set -e",
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
    'rm -rf node_modules; ln -s "$F/node_modules" node_modules',
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
    `exec $S env -i HOME="$HOME" PATH="$PATH" ${vars.join(" ")} sh -c 'echo $$ > "$0"; exec "$@"' ${dir}/pid ${argv.map(shQuote).join(" ")}`,
  ].join("\n");
}

/** Stops one run's process (its group first), as a shell snippet. */
const stopPid = (pidFile: string) =>
  [
    `if [ -f ${pidFile} ]; then p=$(cat ${pidFile}); case "$p" in ''|*[!0-9]*) ;; *)`,
    '  kill -TERM -"$p" 2>/dev/null || kill -TERM "$p" 2>/dev/null || true',
    "  sleep 1",
    '  kill -KILL -"$p" 2>/dev/null || kill -KILL "$p" 2>/dev/null || true;;',
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

/**
 * At each box run's start: every run folder whose slot is no longer
 * granted (`live`: the box's granted run ids) is stopped and removed,
 * left by a dropped ssh. Dependencies unused for 7 days, and leftover
 * temp installs, go too.
 */
export function sweepScript(live: readonly string[]): string {
  for (const id of live) mustId(id);
  return [
    `R=${ROOT}/runs`,
    'if [ -d "$R" ]; then for d in "$R"/*; do',
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
    "exit 0",
  ].join("\n");
}

/** ssh's arguments for `box` (keys only), as the box check uses them. */
export function boxSshArgs(box: GateBox, connectSecs = 15): string[] {
  if (!box.ssh) throw new Error(`box ${box.name} has no ssh`);
  return [
    "-T",
    "-o",
    "BatchMode=yes",
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

/** The tree a run ships: git's files under its top folder. */
export interface BoxTree {
  root: string;
  /** The run's folder inside it ("" for the root). */
  sub: string;
  files: string[];
  untracked: Set<string>;
}

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
  return { root, sub, files, untracked };
}

export interface BoxCpuRun {
  /** The slot's id (checked: a remote path). */
  id: string;
  argv: string[];
  /** Allowed environment: CI, the slot's variables and the --env names. */
  env: Record<string, string>;
  tree: BoxTree;
  /** The box's granted run ids, kept by the sweep. */
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
  const refusedArgs = boxSecretRefusal(
    r.argv,
    Object.fromEntries(
      Object.entries(r.env).filter(([k]) => !/^(CI|GATE_|DEN_GATE_)/.test(k)),
    ),
  );
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
  const plan = shipPlan(r.tree.files, r.tree.untracked, read);
  if (plan.refused) return { ok: false, error: plan.refused };
  const lock = read("package-lock.json");
  if (!lock)
    return {
      ok: false,
      error: `No package-lock.json at the tree's root. ${local}`,
    };
  const sha = createHash("sha256").update(lock).digest("hex");
  const say = d.say ?? (() => {});
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
      const tar = sp("tar", ["-cf", "-", "--null", "-T", "-"], {
        cwd: r.tree.root,
        stdio: ["pipe", "pipe", "inherit"],
        env: { ...process.env, COPYFILE_DISABLE: "1" },
      });
      tar.stdin?.end(plan.ship.join("\0") + "\0");
      const dir = `${ROOT}/runs/${r.id}/tree`;
      const ship = await remote(
        `${sweepScript(r.live)}\nmkdir -p ${dir} && tar -xf - -C ${dir}`,
        { stdin: tar.stdout! },
      );
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
        say(
          `npm ci on ${box.name} failed (exit ${deps.code}). A lockfile that needs a signed-in registry can't install on a box. ${local}`,
        );
        return deps.code;
      }
      const run = await remote(runScript(r.id, r.argv, r.env, r.tree.sub), {
        stream: true,
      });
      if (run.code === 255 && !run.saw) return unreachable();
      return run.code;
    } finally {
      await new Promise<void>((res) => {
        const k = sp("ssh", [...ssh, cleanScript(r.id)], { stdio: "ignore" });
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
      });
      k.on("error", () => {});
      if (s === "SIGKILL" && running)
        (running as ReturnType<typeof nodeSpawn>).kill("SIGKILL");
    },
  };
}
