/**
 * Issue 214: schedules, checks that run on their own (VERIFY-SPEC section 5,
 * decision 10). A schedule is the modules that share an environment, a cron,
 * a window and a name. On a shared environment it runs only under a
 * standing Allow: a person allows its plan once, the Allow lapses when the
 * plan changes, and it expires after verify.schedule.allow_expiry. Local and
 * code-only schedules need no Allow. Code-only means every module only
 * reads the code and none runs a command (`cmd`): a command needs the Allow
 * on any shared environment.
 *
 * The plan's fingerprint covers everything a run uses: each module's repo,
 * command, results file, writes, environments and health URLs for the
 * environment, the environment's method rule, and the bytes of the files a
 * command names (its scripts, and a Makefile or package manifest it runs).
 *
 * Allows live in <state>/verify/<project>/schedule-allows.json (0600).
 */
import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";
import type { VerifyModule } from "./config.js";
import type { RunActor } from "./records.js";
import { nextRun } from "./cron.js";
import { writeFileAtomic } from "../atomic-write.js";

export interface Schedule {
  /** Stable across plan changes: from the project, environment, cron, window and name. */
  id: string;
  project: string;
  name?: string;
  env: string;
  cron: string;
  window?: string;
  modules: VerifyModule[];
  /** The environment isn't local. */
  shared: boolean;
  /** Every module only reads the code, and none runs a command. */
  codeOnly: boolean;
  needsAllow: boolean;
  /** The plan's fingerprint: any change to it lapses the Allow. */
  hash: string;
}

export interface ScheduleAllow {
  schedule: string;
  hash: string;
  by: RunActor;
  at: string;
  expiresAt: string;
  /** What was allowed, so the page can say what changed. */
  modules: { id: string; cmd?: string; writes: boolean }[];
  env: string;
  cron: string;
  window?: string;
  /**
   * Issue 964: each repo's commit when the person allowed it, for a
   * schedule that runs a command on a shared environment. The command
   * runs from these files, never the working tree.
   */
  commits?: Record<string, string>;
}

/** Issue 964: what production schedules may do (verify.schedule.production). */
export interface ProductionScheduleSettings {
  /** The org's opt-in: off, no production schedule runs or takes an Allow. */
  enabled: boolean;
  /** The shortest gap a production schedule may run at. */
  minIntervalMs: number;
  /** The hosts a production run may reach; null: any host, but never a link-local or metadata one. */
  hosts: string[] | null;
}

export interface ScheduleSettings {
  allowExpiryMs: number;
  expiryWarningMs: number;
  /**
   * verify.schedule.shared_commands: whether a schedule on a shared
   * environment may run a command (`cmd`). Off by default: Den can't see
   * all a command will run, so until a run can be pinned to the commit its
   * Allow named, a command runs on its own only where the org turns it on.
   */
  sharedCommands: boolean;
  production: ProductionScheduleSettings;
}

const DAY = 86_400_000;
const MINUTE = 60_000;
export const SCHEDULE_DEFAULTS: Readonly<ScheduleSettings> = Object.freeze({
  allowExpiryMs: 30 * DAY,
  expiryWarningMs: 3 * DAY,
  sharedCommands: false,
  production: Object.freeze({
    enabled: false,
    minIntervalMs: 15 * MINUTE,
    hosts: null,
  }),
});

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};

function span(v: unknown, name: string, fallback: number): number {
  if (v === undefined || v === null) return fallback;
  let ms = NaN;
  if (typeof v === "number") ms = v * DAY;
  else if (typeof v === "string") {
    const m = /^(\d+(?:\.\d+)?)\s*([dhm])$/.exec(v.trim());
    if (m)
      ms =
        Number(m[1]) * (m[2] === "d" ? DAY : m[2] === "h" ? 3_600_000 : MINUTE);
  }
  if (!Number.isFinite(ms) || ms <= 0)
    throw new Error(
      `verify.schedule.${name}: days as a number (30), or "30d", "12h" or "15m", got ${JSON.stringify(v)}`,
    );
  return ms;
}

function hostList(v: unknown): string[] | null {
  if (v === undefined || v === null) return null;
  if (
    !Array.isArray(v) ||
    v.some((h) => typeof h !== "string" || !/^[a-z0-9.:[\]-]+$/i.test(h))
  )
    throw new Error(
      `verify.schedule.production.hosts: a list of host names, like ["shop.example.com"], got ${JSON.stringify(v)}`,
    );
  return v.map((h) => h.toLowerCase());
}

function readProduction(v: unknown): ProductionScheduleSettings {
  const p = obj(v);
  const d = SCHEDULE_DEFAULTS.production;
  if (p.enabled !== undefined && typeof p.enabled !== "boolean")
    throw new Error(
      `verify.schedule.production.enabled: true or false, got ${JSON.stringify(p.enabled)}`,
    );
  return {
    enabled: p.enabled === true,
    minIntervalMs: span(
      p.min_interval,
      "production.min_interval",
      d.minIntervalMs,
    ),
    hosts: hostList(p.hosts),
  };
}

/** verify.schedule.allow_expiry, expiry_warning and production, from Den's `verify:` block. */
export function readScheduleSettings(raw: unknown): ScheduleSettings {
  const s = obj(obj(raw).schedule);
  if (s.shared_commands !== undefined && typeof s.shared_commands !== "boolean")
    throw new Error(
      `verify.schedule.shared_commands: true or false, got ${JSON.stringify(s.shared_commands)}`,
    );
  return {
    sharedCommands: s.shared_commands === true,
    production: readProduction(s.production),
    allowExpiryMs: span(
      s.allow_expiry,
      "allow_expiry",
      SCHEDULE_DEFAULTS.allowExpiryMs,
    ),
    expiryWarningMs: span(
      s.expiry_warning,
      "expiry_warning",
      SCHEDULE_DEFAULTS.expiryWarningMs,
    ),
  };
}

const sha = (s: string | Buffer) =>
  createHash("sha256").update(s).digest("hex");

/** What a run uses besides its modules' own fields. */
export interface PlanInputs {
  /** The environment's method rule (verify.environments.<env>). */
  rules?: (env: string) => unknown;
  /** The files a module's command names, path → sha256 (null: missing). */
  files?: (m: VerifyModule) => Record<string, string | null>;
}

/** A module runs a command Den can't see inside. */
export const runsCmd = (m: VerifyModule) => m.cmd !== undefined;

/** Only reads the code and runs no command: needs no Allow. */
export const codeOnlyModule = (m: VerifyModule) =>
  m.mark === "reads-code-only" && !runsCmd(m);

const SCRIPT_RE = /\.(?:sh|bash|zsh|mjs|cjs|js|ts|py|rb|pl|php)$/;
const RUNNERS: Record<string, string[]> = {
  make: ["Makefile", "GNUmakefile", "makefile"],
  npm: ["package.json", "package-lock.json"],
  npx: ["package.json", "package-lock.json"],
  pnpm: ["package.json", "pnpm-lock.yaml"],
  yarn: ["package.json", "yarn.lock"],
  bun: ["package.json", "bun.lockb"],
  node: ["package.json"],
  just: ["justfile", "Justfile"],
  task: ["Taskfile.yml"],
};

/**
 * The files in the repo a command names, path → sha256 of its bytes, or
 * null when the path names no file: a script it calls (a word with a slash
 * or a script's extension), and the Makefile or package manifest of a
 * runner it starts. A path outside the repo is kept by name only.
 */
export function cmdFiles(
  repoPath: string,
  cmd: string,
): Record<string, string | null> {
  const root = path.resolve(repoPath);
  const names = new Set<string>();
  for (const seg of cmd.split(/&&|\|\||[;&|\n]/)) {
    const words = seg
      .trim()
      .split(/\s+/)
      .map((w) => w.replace(/^['"]|['"]$/g, ""))
      .filter((w) => w && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w));
    if (!words.length) continue;
    for (const f of RUNNERS[path.basename(words[0])] ?? []) names.add(f);
    for (const w of words)
      if (!w.startsWith("-") && (w.includes("/") || SCRIPT_RE.test(w)))
        names.add(w);
  }
  const out: Record<string, string | null> = {};
  for (const n of [...names].sort()) {
    const abs = path.resolve(root, n);
    if (abs !== root && !abs.startsWith(root + path.sep)) {
      out[n] = "outside";
      continue;
    }
    try {
      out[n] = fs.statSync(abs).isFile() ? sha(fs.readFileSync(abs)) : null;
    } catch {
      out[n] = null;
    }
  }
  return out;
}

/** The plan behind a schedule: what runs, how, where and when. */
export function planHash(p: {
  env: string;
  cron: string;
  window?: string;
  modules: VerifyModule[];
  inputs?: PlanInputs;
}): string {
  const mods = [...p.modules]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((m) => ({
      id: m.id,
      repo: m.repo,
      repoPath: m.repoPath,
      layer: m.layer,
      adapter: m.adapter,
      mark: m.mark,
      cmd: m.cmd ?? null,
      results: m.results ?? null,
      writes: m.writes,
      environments: m.environments,
      health: m.healthUrls[p.env] ?? [],
      files: runsCmd(m) ? (p.inputs?.files?.(m) ?? null) : null,
    }));
  return sha(
    JSON.stringify({
      env: p.env,
      cron: p.cron,
      window: p.window ?? null,
      rules: p.inputs?.rules?.(p.env) ?? null,
      mods,
    }),
  ).slice(0, 16);
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 28);
}

function idOf(
  project: string,
  k: { env: string; cron: string; window?: string; name?: string },
) {
  const h = sha(
    JSON.stringify([project, k.env, k.cron, k.window ?? null, k.name ?? null]),
  ).slice(0, 8);
  const lead = slug(k.name ?? k.env);
  return lead ? `${lead}-${h}` : h;
}

/** Every schedule in a project's modules, sorted by environment then name. */
export function listSchedules(
  project: string,
  modules: VerifyModule[],
  inputs?: PlanInputs,
): Schedule[] {
  const groups = new Map<string, VerifyModule[]>();
  for (const m of modules) {
    if (!m.schedule) continue;
    const s = m.schedule;
    const key = JSON.stringify([
      s.env,
      s.cron,
      s.window ?? null,
      s.name ?? null,
    ]);
    groups.set(key, [...(groups.get(key) ?? []), m]);
  }
  const out: Schedule[] = [];
  for (const mods of groups.values()) {
    const s = mods[0].schedule!;
    const sorted = [...mods].sort((a, b) => a.name.localeCompare(b.name));
    const shared = s.env !== "local";
    const codeOnly = sorted.every(codeOnlyModule);
    out.push({
      id: idOf(project, s),
      project,
      ...(s.name ? { name: s.name } : {}),
      env: s.env,
      cron: s.cron,
      ...(s.window !== undefined ? { window: s.window } : {}),
      modules: sorted,
      shared,
      codeOnly,
      needsAllow: shared && !codeOnly,
      hash: planHash({
        env: s.env,
        cron: s.cron,
        window: s.window,
        modules: sorted,
        ...(inputs ? { inputs } : {}),
      }),
    });
  }
  return out.sort(
    (a, b) =>
      a.env.localeCompare(b.env) ||
      (a.name ?? "").localeCompare(b.name ?? "") ||
      a.id.localeCompare(b.id),
  );
}

const fileOf = (stateDir: string, project: string) =>
  path.join(stateDir, "verify", project, "schedule-allows.json");

export function readAllows(
  stateDir: string,
  project: string,
): Record<string, ScheduleAllow> {
  try {
    const v = JSON.parse(fs.readFileSync(fileOf(stateDir, project), "utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

function save(
  stateDir: string,
  project: string,
  all: Record<string, ScheduleAllow>,
) {
  const file = fileOf(stateDir, project);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeFileAtomic(file, JSON.stringify(all, null, 2) + "\n", { mode: 0o600 });
}

/** A person allows the schedule's plan as it is now. */
export function writeAllow(
  stateDir: string,
  project: string,
  s: Schedule,
  by: RunActor,
  now: Date,
  settings: ScheduleSettings,
  commits?: Record<string, string>,
): ScheduleAllow {
  const a: ScheduleAllow = {
    schedule: s.id,
    hash: s.hash,
    by,
    at: now.toISOString(),
    expiresAt: new Date(now.getTime() + settings.allowExpiryMs).toISOString(),
    modules: s.modules.map((m) => ({
      id: m.id,
      ...(m.cmd !== undefined ? { cmd: m.cmd } : {}),
      writes: m.writes,
    })),
    env: s.env,
    cron: s.cron,
    ...(s.window !== undefined ? { window: s.window } : {}),
    ...(commits && Object.keys(commits).length ? { commits } : {}),
  };
  save(stateDir, project, { ...readAllows(stateDir, project), [s.id]: a });
  return a;
}

export function removeAllow(
  stateDir: string,
  project: string,
  id: string,
): void {
  const all = readAllows(stateDir, project);
  if (!(id in all)) return;
  delete all[id];
  save(stateDir, project, all);
}

export type ScheduleState =
  | "no-allow-needed"
  | "needs-allow"
  | "allowed"
  | "expiring"
  | "expired"
  | "plan-changed";

export function scheduleState(
  s: Schedule,
  a: ScheduleAllow | undefined,
  now: Date,
  settings: ScheduleSettings,
): ScheduleState {
  if (!s.needsAllow) return "no-allow-needed";
  if (!a) return "needs-allow";
  if (a.hash !== s.hash) return "plan-changed";
  const left = Date.parse(a.expiresAt) - now.getTime();
  if (!(left > 0)) return "expired";
  return left <= settings.expiryWarningMs ? "expiring" : "allowed";
}

const INTERPRETERS = new Set([
  "sh",
  "bash",
  "zsh",
  "node",
  "python",
  "python3",
  "ruby",
  "perl",
]);

/**
 * Whether Den understands a command's shape well enough to fingerprint it:
 * one or more steps joined by `&&`, each a script in the repo (`./x.sh`)
 * or an interpreter and a script in the repo (`bash scripts/x.sh --quick`),
 * every named file there. No shell syntax beyond that (no $, quotes,
 * pipes, redirects, globs, `;`, `cd` or variables), no interpreter flags
 * (`-c`, `-m`, `-e`), and no runner whose own file says what runs next
 * (make, npm and the like): what those call isn't followed, so they are
 * refused. Returns null when understood, else why not.
 */
export function cmdUnclear(repoPath: string, cmd: string): string | null {
  if (/[$`'"\\<>|;*?~(){}[\]!#\n]/.test(cmd))
    return "it uses shell syntax Den doesn't follow";
  const root = path.resolve(repoPath);
  const file = (w: string) => {
    const abs = path.resolve(root, w);
    if (abs === root || !abs.startsWith(root + path.sep)) return false;
    try {
      return fs.statSync(abs).isFile();
    } catch {
      return false;
    }
  };
  const steps = cmd
    .split("&&")
    .map((x) => x.trim().split(/\s+/).filter(Boolean));
  if (!steps.length || steps.some((w) => !w.length))
    return "it has an empty step";
  for (const w of steps) {
    if (w.some((x) => x.includes("&")))
      return "it uses shell syntax Den doesn't follow";
    const odd = w.find((x) => !/^[A-Za-z0-9._/=:@,+-]+$/.test(x));
    if (odd !== undefined) return `${odd} has characters Den doesn't follow`;
    if (/=/.test(w[0])) return "it sets a variable";
    let i = 0;
    if (INTERPRETERS.has(w[0])) {
      i = 1;
      if (!w[1] || w[1].startsWith("-"))
        return `${w[0]} takes a script in the repo, with no flags before it`;
    } else if (!(w[0].includes("/") || SCRIPT_RE.test(w[0])))
      return `${w[0]} isn't a script in the repo`;
    if (!file(w[i])) return `${w[i]} isn't a file in the repo`;
    for (const a of w.slice(i + 1))
      if (
        !a.startsWith("-") &&
        (a.includes("/") || SCRIPT_RE.test(a)) &&
        !file(a)
      )
        return `${a} isn't a file in the repo`;
  }
  return null;
}

/** Why a schedule's commands may not run on their own, or null. */
export function commandLimit(
  s: Schedule,
  settings: ScheduleSettings,
): { reason: "commands-off" | "command-unclear"; why?: string } | null {
  if (!s.shared) return null;
  const cmds = s.modules.filter(runsCmd);
  if (!cmds.length) return null;
  if (!(settings.sharedCommands ?? false)) return { reason: "commands-off" };
  for (const m of cmds) {
    const why = cmdUnclear(m.repoPath, m.cmd!);
    if (why) return { reason: "command-unclear", why: `${m.name}: ${why}` };
  }
  return null;
}

/** Issue 964: why a production schedule may not run or take an Allow. */
export type ProductionLimit = "production-off" | "too-often" | "host";

/** The shortest gap between two runs of `cron`, over the next two weeks. */
export function shortestGapMs(cron: string, from = new Date(0)): number {
  let min = Infinity;
  let prev = nextRun(cron, from);
  const end = (prev?.getTime() ?? 0) + 14 * DAY;
  for (let i = 0; prev && i < 5000 && prev.getTime() < end; i++) {
    const next = nextRun(cron, prev);
    if (!next) break;
    min = Math.min(min, next.getTime() - prev.getTime());
    prev = next;
  }
  return min;
}

/** A link-local or cloud metadata address: never a production run's to reach. */
export function metadataHost(host: string): boolean {
  const h = host
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "")
    .replace(/^::ffff:/, "");
  return (
    /^169\.254\./.test(h) ||
    /^fe[89ab][0-9a-f]:/.test(h) ||
    h === "fd00:ec2::254" ||
    h === "100.100.100.200" ||
    h === "metadata" ||
    h === "metadata.google.internal" ||
    h.endsWith(".metadata.google.internal")
  );
}

/** The hosts a schedule's run reaches on its environment (its smoke URLs). */
export function hostsOf(s: Schedule): string[] {
  const out = new Set<string>();
  for (const m of s.modules)
    for (const u of m.healthUrls[s.env] ?? []) {
      try {
        out.add(new URL(u).hostname.toLowerCase());
      } catch {
        out.add(u);
      }
    }
  return [...out].sort();
}

/**
 * Why a production schedule may not run (or be allowed), or null: the
 * org hasn't opted in, it runs more often than min_interval, or a URL it
 * reaches is a metadata address or off the host list. Other environments:
 * null.
 */
export function productionLimit(
  s: Schedule,
  settings: ScheduleSettings,
): { reason: ProductionLimit; hosts?: string[] } | null {
  if (s.env !== "production") return null;
  const p = settings.production ?? SCHEDULE_DEFAULTS.production;
  if (!p.enabled) return { reason: "production-off" };
  if (shortestGapMs(s.cron) < p.minIntervalMs) return { reason: "too-often" };
  const bad = hostsOf(s).filter(
    (h) => metadataHost(h) || (p.hosts !== null && !p.hosts.includes(h)),
  );
  if (bad.length) return { reason: "host", hosts: bad };
  return null;
}

/** Every reason a schedule may not run on its own, or be allowed. */
export type ScheduleLimitReason =
  | ProductionLimit
  | "commands-off"
  | "command-unclear";

export interface ScheduleLimit {
  reason: ScheduleLimitReason;
  /** command-unclear: the module and why. */
  why?: string;
  /** host: the hosts off the list, or metadata addresses. */
  hosts?: string[];
}

/** The production limit first (issue 964), then the command limit. */
export function scheduleLimit(
  s: Schedule,
  settings: ScheduleSettings,
): ScheduleLimit | null {
  return productionLimit(s, settings) ?? commandLimit(s, settings);
}

/** What the Allow route says when a limit refuses it. */
export function limitMessage(l: ScheduleLimit): string {
  switch (l.reason) {
    case "production-off":
      return "Schedules don't run on production here (verify.schedule.production.enabled is off).";
    case "too-often":
      return "This schedule runs on production more often than verify.schedule.production.min_interval allows.";
    case "host":
      return `This schedule reaches a host a production run may not: ${(l.hosts ?? []).join(", ")}.`;
    case "commands-off":
      return "Commands don't run on their own on a shared environment here (verify.schedule.shared_commands is off).";
    default:
      return `Den can't follow this schedule's command, so it can't be allowed: ${l.why}.`;
  }
}

/** The modules whose commands run from a pinned commit: a shared schedule's. */
export function pinnedModules(s: Schedule): Schedule["modules"] {
  return s.shared ? s.modules.filter(runsCmd) : [];
}

export function mayRun(
  s: Schedule,
  a: ScheduleAllow | undefined,
  now: Date,
  settings: ScheduleSettings,
): boolean {
  if (scheduleLimit(s, settings)) return false;
  if (productionLimit(s, settings)) return false;
  const st = scheduleState(s, a, now, settings);
  return st === "no-allow-needed" || st === "allowed" || st === "expiring";
}
