/**
 * D28: session-rotation settings and where each comes from.
 *
 *   after_compactions  a whole number (1–100), or "never"; default 3
 *   on_due             auto | ask | off; default auto
 *                        auto: Den asks the agent for its handoff at its next
 *                              idle and relaunches it from it by itself
 *                        ask:  the callout's buttons (Relaunch now, Write
 *                              handoff, Keep this conversation, Settings)
 *                        off:  nothing happens; the count is still shown
 *   on_pr_merged       true | false; default true
 *
 * Scopes, the most specific wins, each key on its own:
 *   agent › persona in a workspace › persona › workspace › service (the
 *   workspace service whose folder holds the agent's) › install (Settings ›
 *   Agents › Rotation, this machine) › org (`agents.rotate` in the org
 *   config) › Den's default.
 *
 * The install value and every override live in
 * `<stateDir>/agent-rotation.json` (0600; never under agents/, where every
 * file is an agent's record). The org value is the org config's.
 */
import * as fs from "fs";
import * as path from "path";
import { writePrivate } from "./records.js";

export type OnDue = "auto" | "ask" | "off";

/** One scope's settings, as written: any key may be absent. */
export interface RotateValues {
  after_compactions?: number | "never";
  on_due?: OnDue;
  on_pr_merged?: boolean;
}

export type RotateKey = keyof RotateValues;
export const ROTATE_KEYS: readonly RotateKey[] = [
  "after_compactions",
  "on_due",
  "on_pr_merged",
];

/** The scopes an override can be set at (most specific first). */
export const OVERRIDE_SCOPES = [
  "agent",
  "persona-workspace",
  "persona",
  "workspace",
  "service",
] as const;
export type OverrideScope = (typeof OVERRIDE_SCOPES)[number];
export type RotateScope = OverrideScope | "install" | "org" | "default";

export const ROTATE_DEFAULTS: Required<RotateValues> = {
  after_compactions: 3,
  on_due: "auto",
  on_pr_merged: true,
};

/** `<stateDir>/agent-rotation.json`. */
export interface RotateFile {
  install?: RotateValues;
  overrides?: Partial<Record<OverrideScope, Record<string, RotateValues>>>;
}

/** Who an agent is, for resolving its settings. */
export interface RotateSubject {
  agent: string;
  persona: string;
  workspace: string;
  /** The workspace service whose folder holds the agent's, if any. */
  service?: string;
  /** A standing persona (planner, orchestrator): `standing: false` in the org config keeps it from rotating. */
  standing?: boolean;
}

/** Where a value came from: "default", or a scope and its target. */
export interface RotateSource {
  scope: RotateScope;
  /** The agent id, persona, "persona@workspace", workspace or service. */
  target?: string;
}

export interface EffectiveRotate {
  /** 0: never rotates. */
  afterCompactions: number;
  onDue: OnDue;
  onPrMerged: boolean;
  source: Record<RotateKey, RotateSource>;
}

/** The org config's `agents.rotate`, checked (den-config.ts). */
export interface OrgRotate extends RotateValues {
  /** Dropped by D28 (persona scope replaces it); still honoured. */
  standing?: boolean;
}

export const rotateFilePath = (stateDir: string) =>
  path.join(stateDir, "agent-rotation.json");

/**
 * One value checked: the problem in words, or null. `after_compactions`
 * takes 1–100 or "never" (0 also means never, from the CLI).
 */
export function checkRotateValue(key: string, v: unknown): string | null {
  if (key === "after_compactions")
    return v === "never" ||
      (typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 100)
      ? null
      : `after_compactions: a whole number from 1 to 100, or never (got ${JSON.stringify(v)})`;
  if (key === "on_due")
    return v === "auto" || v === "ask" || v === "off"
      ? null
      : `on_due: auto, ask or off (got ${JSON.stringify(v)})`;
  if (key === "on_pr_merged")
    return typeof v === "boolean"
      ? null
      : `on_pr_merged: true or false (got ${JSON.stringify(v)})`;
  return `${key}: unknown key (takes ${ROTATE_KEYS.join(", ")})`;
}

/** A command-line value as the key takes it ("3", "never", "ask", "false"). */
export function parseRotateValue(key: string, raw: string): unknown {
  if (key === "after_compactions")
    return raw === "never" || raw === "0"
      ? "never"
      : /^\d+$/.test(raw)
        ? Number(raw)
        : raw;
  if (key === "on_pr_merged")
    return raw === "true" ? true : raw === "false" ? false : raw;
  return raw;
}

/** Only the valid keys of `v` (a bad file never breaks an agent). */
function cleanValues(v: unknown): RotateValues {
  const out: RotateValues = {};
  if (!v || typeof v !== "object" || Array.isArray(v)) return out;
  for (const k of ROTATE_KEYS) {
    const x = (v as Record<string, unknown>)[k];
    if (x !== undefined && checkRotateValue(k, x) === null)
      (out as Record<string, unknown>)[k] = x;
  }
  return out;
}

/** agent-rotation.json, cleaned; {} when absent or unreadable. */
export function readRotateFile(stateDir: string): RotateFile {
  let v: unknown;
  try {
    v = JSON.parse(fs.readFileSync(rotateFilePath(stateDir), "utf-8"));
  } catch {
    return {};
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const o = v as Record<string, unknown>;
  const out: RotateFile = {};
  const inst = cleanValues(o.install);
  if (Object.keys(inst).length) out.install = inst;
  if (o.overrides && typeof o.overrides === "object") {
    const ov: RotateFile["overrides"] = {};
    for (const scope of OVERRIDE_SCOPES) {
      const byTarget = (o.overrides as Record<string, unknown>)[scope];
      if (!byTarget || typeof byTarget !== "object") continue;
      for (const [target, vals] of Object.entries(byTarget)) {
        const c = cleanValues(vals);
        if (Object.keys(c).length) (ov[scope] ??= {})[target] = c;
      }
    }
    if (Object.keys(ov).length) out.overrides = ov;
  }
  return out;
}

export function writeRotateFile(stateDir: string, f: RotateFile): void {
  fs.mkdirSync(path.dirname(rotateFilePath(stateDir)), {
    recursive: true,
    mode: 0o700,
  });
  writePrivate(rotateFilePath(stateDir), JSON.stringify(f, null, 2) + "\n");
}

/**
 * Set (or with `value` undefined, clear) one key at one scope. `scope`
 * "install" takes no target. Throws, naming the problem, on a bad key or
 * value. Returns the file as written.
 */
export function setRotateValue(
  stateDir: string,
  scope: OverrideScope | "install",
  target: string | undefined,
  key: string,
  value: unknown,
): RotateFile {
  if (value !== undefined) {
    const bad = checkRotateValue(key, value);
    if (bad) throw new Error(bad);
  } else if (!(ROTATE_KEYS as readonly string[]).includes(key))
    throw new Error(checkRotateValue(key, undefined)!);
  if (scope !== "install" && !target)
    throw new Error(`a ${scope} override needs the ${scope} it is for`);
  const f = readRotateFile(stateDir);
  const k = key as RotateKey;
  const apply = (vals: RotateValues | undefined): RotateValues => {
    const next: RotateValues = { ...(vals ?? {}) };
    if (value === undefined) delete next[k];
    else (next as Record<string, unknown>)[k] = value;
    return next;
  };
  if (scope === "install") {
    const next = apply(f.install);
    if (Object.keys(next).length) f.install = next;
    else delete f.install;
  } else {
    const ov = (f.overrides ??= {});
    const byTarget = (ov[scope] ??= {});
    const next = apply(byTarget[target!]);
    if (Object.keys(next).length) byTarget[target!] = next;
    else delete byTarget[target!];
    if (!Object.keys(byTarget).length) delete ov[scope];
    if (!Object.keys(ov).length) delete f.overrides;
  }
  writeRotateFile(stateDir, f);
  return f;
}

/** The target an override scope uses for `s`, or undefined. */
export function targetFor(
  scope: OverrideScope,
  s: RotateSubject,
): string | undefined {
  switch (scope) {
    case "agent":
      return s.agent;
    case "persona-workspace":
      return `${s.persona}@${s.workspace}`;
    case "persona":
      return s.persona;
    case "workspace":
      return s.workspace;
    case "service":
      return s.service;
  }
}

/** Agent `s`'s settings, each key from the most specific scope that sets it. */
export function resolveRotate(
  s: RotateSubject,
  file: RotateFile,
  org: OrgRotate | undefined,
): EffectiveRotate {
  const layers: { source: RotateSource; values: RotateValues }[] = [];
  for (const scope of OVERRIDE_SCOPES) {
    const target = targetFor(scope, s);
    const values = target ? file.overrides?.[scope]?.[target] : undefined;
    if (values) layers.push({ source: { scope, target }, values });
  }
  if (file.install)
    layers.push({ source: { scope: "install" }, values: file.install });
  if (org) {
    const values: RotateValues = { ...org };
    delete (values as OrgRotate).standing;
    // den#4's `standing: false`: standing personas never rotate.
    if (org.standing === false && s.standing)
      values.after_compactions = "never";
    layers.push({ source: { scope: "org" }, values });
  }
  const pick = <K extends RotateKey>(k: K) => {
    for (const l of layers)
      if (l.values[k] !== undefined)
        return {
          v: l.values[k] as Required<RotateValues>[K],
          source: l.source,
        };
    return {
      v: ROTATE_DEFAULTS[k],
      source: { scope: "default" } as RotateSource,
    };
  };
  const a = pick("after_compactions");
  const o = pick("on_due");
  const p = pick("on_pr_merged");
  return {
    afterCompactions: a.v === "never" ? 0 : a.v,
    onDue: o.v,
    onPrMerged: p.v,
    source: {
      after_compactions: a.source,
      on_due: o.source,
      on_pr_merged: p.source,
    },
  };
}

/** "persona planner", "agent art", "this install", "org config", "default". */
export function sourceText(src: RotateSource): string {
  switch (src.scope) {
    case "default":
      return "default";
    case "install":
      return "this install";
    case "org":
      return "org config";
    case "persona-workspace":
      return `persona ${src.target!.replace("@", " in ")}`;
    default:
      return `${src.scope} ${src.target}`;
  }
}
