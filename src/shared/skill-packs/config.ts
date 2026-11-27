import type { Packs, PackPin } from "./pin.js";

export const MAX_SKILL_LIST = 200;

export interface PackChoice {
  on: boolean;
  skills: "all" | string[];
  exclude: string[];
}

export interface SkillPacksConfig {
  on: boolean;
  packs: Record<string, PackChoice>;
}

export type AgentPacks =
  | { mode: "off" }
  | { mode: "on" }
  | { mode: "list"; packs: string[] };

export interface AgentPack {
  name: string;
  skills: string[];
}

const isMapping = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export function skillsOf(pin: PackPin): string[] {
  const out = new Set<string>();
  for (const f of Object.keys(pin.files)) {
    const m = /^skills\/([^/]+)\/SKILL\.md$/.exec(f);
    if (m) out.add(m[1]!);
  }
  return [...out].sort();
}

export function defaultSkills(pin: PackPin): string[] {
  const off = new Set((pin.default_off ?? []).map((x) => x.skill));
  return skillsOf(pin).filter((s) => !off.has(s));
}

const describe = (v: unknown) =>
  typeof v === "string"
    ? `a string of ${[...v].length} characters`
    : "not a string";

function bool(v: unknown, where: string, dflt: boolean): boolean {
  if (v === undefined || v === null) return dflt;
  if (typeof v !== "boolean") throw new Error(`${where}: true or false`);
  return v;
}

function nameList(
  v: unknown,
  where: string,
  known: readonly string[],
  what: string,
): string[] {
  if (!Array.isArray(v)) throw new Error(`${where}: a list of ${what}`);
  if (v.length > MAX_SKILL_LIST)
    throw new Error(`${where}: at most ${MAX_SKILL_LIST}`);
  v.forEach((x, i) => {
    if (typeof x !== "string" || !known.includes(x))
      throw new Error(
        `${where}[${i}]: not ${what.replace(/s$/, "")} (${describe(x)})`,
      );
  });
  return [...new Set(v as string[])].sort();
}

export function parseSkillPacks(
  raw: unknown,
  where: string,
  packs: Packs,
): SkillPacksConfig {
  const names = Object.keys(packs).sort();
  const out: SkillPacksConfig = {
    on: true,
    packs: Object.fromEntries(
      names.map((n) => [n, { on: true, skills: "all", exclude: [] }]),
    ),
  };
  if (raw === undefined || raw === null) return out;
  if (!isMapping(raw))
    throw new Error(
      `${where}: a mapping of on and the packs (${names.join(", ")})`,
    );
  for (const [k, v] of Object.entries(raw)) {
    if (k === "on") {
      out.on = bool(v, `${where}.on`, true);
      continue;
    }
    const pin = packs[k];
    if (!pin)
      throw new Error(
        `${where}.${k}: not a pack Den ships (${names.join(", ")})`,
      );
    if (v === undefined || v === null) continue;
    if (!isMapping(v))
      throw new Error(`${where}.${k}: a mapping of on, skills and exclude`);
    const skills = skillsOf(pin);
    const choice = out.packs[k]!;
    for (const [kk, vv] of Object.entries(v)) {
      const at = `${where}.${k}.${kk}`;
      if (kk === "on") choice.on = bool(vv, at, true);
      else if (kk === "skills")
        choice.skills =
          vv === undefined || vv === null || vv === "all"
            ? "all"
            : nameList(vv, at, skills, `skills in ${k}'s pin`);
      else if (kk === "exclude")
        choice.exclude =
          vv === undefined || vv === null
            ? []
            : nameList(vv, at, skills, `skills in ${k}'s pin`);
      else throw new Error(`${at}: not a key here (on, skills, exclude)`);
    }
  }
  return out;
}

export function parseAgentSkillPacks(
  raw: unknown,
  where: string,
  packs: Packs,
): AgentPacks | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (raw === "off" || raw === false) return { mode: "off" };
  if (raw === "on" || raw === true) return { mode: "on" };
  if (Array.isArray(raw))
    return {
      mode: "list",
      packs: nameList(raw, where, Object.keys(packs), "packs Den ships"),
    };
  throw new Error(`${where}: off, on, or a list of packs (${describe(raw)})`);
}

export function resolveAgentPacks(
  install: SkillPacksConfig,
  persona: AgentPacks | undefined,
  agent: AgentPacks | undefined,
  packs: Packs,
): AgentPack[] {
  if (!install.on) return [];
  const mine = agent ? (agent.mode === "on" ? undefined : agent) : persona;
  if (mine?.mode === "off") return [];
  const out: AgentPack[] = [];
  for (const name of Object.keys(packs).sort()) {
    const choice = install.packs[name];
    if (!choice?.on) continue;
    if (mine?.mode === "list" && !mine.packs.includes(name)) continue;
    const pin = packs[name]!;
    const base = choice.skills === "all" ? defaultSkills(pin) : choice.skills;
    const skills = base.filter((s) => !choice.exclude.includes(s)).sort();
    if (skills.length) out.push({ name, skills });
  }
  return out;
}
