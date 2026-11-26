import fs from "node:fs";
import path from "node:path";
import * as yaml from "yaml";
import type { DenConfig, UserConfig } from "../../shared/den-config.js";
import {
  defaultSkills,
  resolveAgentPacks,
  skillsOf,
} from "../../shared/skill-packs/config.js";
import {
  readSkillPacksConfig,
  SKILL_PACKS_DIR,
} from "../../shared/skill-packs/launch.js";
import { readPacks, type Packs } from "../../shared/skill-packs/pin.js";
import {
  isSkillPackKey,
  patchSkillPackKey,
} from "../cli/config-skill-packs.js";

export interface SkillPackRow {
  name: string;
  on: boolean;
  license: string;
  copyright: string;
  commit: string;
  source: string;
  path: string;
  skills: {
    name: string;
    description: string;
    on: boolean;
    byDefault: boolean;
  }[];
  skillsOn: number;
  tokens: number;
}

export interface SkillPacksData {
  on: boolean;
  packs: SkillPackRow[];
}

const descCache = new Map<string, string>();

function descriptionOf(packsDir: string, pack: string, skill: string): string {
  const file = path.join(packsDir, pack, "skills", skill, "SKILL.md");
  const hit = descCache.get(file);
  if (hit !== undefined) return hit;
  let d = "";
  try {
    const m = /^---\n([\s\S]*?)\n---/.exec(fs.readFileSync(file, "utf8"));
    const front: unknown = m ? yaml.parse(m[1]!) : null;
    const v = (front as { description?: unknown } | null)?.description;
    d = typeof v === "string" ? v.slice(0, 600) : "";
  } catch {
    d = "";
  }
  descCache.set(file, d);
  return d;
}

export function skillPacksData(
  user: UserConfig,
  den: DenConfig,
  packsDir: string = SKILL_PACKS_DIR,
  packs: Packs = readPacks(packsDir),
): SkillPacksData {
  const install = readSkillPacksConfig(
    den.skill_packs,
    user.skill_packs,
    packs,
  );
  const on = new Map(
    resolveAgentPacks(install, undefined, undefined, packs).map((p) => [
      p.name,
      new Set(p.skills),
    ]),
  );
  return {
    on: install.on,
    packs: Object.keys(packs)
      .sort()
      .map((name) => {
        const pin = packs[name]!;
        const choice = install.packs[name]!;
        const base = new Set(
          choice.skills === "all" ? defaultSkills(pin) : choice.skills,
        );
        const chosen = new Set(
          [...base].filter((s) => !choice.exclude.includes(s)),
        );
        const dflt = new Set(defaultSkills(pin));
        const skills = skillsOf(pin).map((s) => ({
          name: s,
          description: descriptionOf(packsDir, name, s),
          on: chosen.has(s),
          byDefault: dflt.has(s),
        }));
        const loaded = on.get(name) ?? new Set<string>();
        const tokens = Math.ceil(
          skills
            .filter((s) => loaded.has(s.name))
            .reduce((n, s) => n + s.name.length + s.description.length + 8, 0) /
            4,
        );
        return {
          name,
          on: choice.on,
          license: pin.license,
          copyright: pin.copyright,
          commit: pin.commit,
          source: pin.source,
          path: pin.path,
          skills,
          skillsOn: loaded.size,
          tokens,
        };
      }),
  };
}

export const MAX_SKILL_PACK_EDITS = 8;

export function patchSkillPacksBody(
  user: Record<string, unknown>,
  body: unknown,
  den: DenConfig,
): { ok: true } | { ok: false; error: string } {
  const edits = Array.isArray(body) ? body : [body];
  const usage =
    "skill_packs: { key, value } or a list of them, each key one of skill_packs.on, skill_packs.<pack>.on|skills|exclude or agents.<id>.skill_packs";
  if (!edits.length || edits.length > MAX_SKILL_PACK_EDITS)
    return { ok: false, error: usage };
  const next = structuredClone(user);
  for (const e of edits as unknown[]) {
    const b = e as { key?: unknown; value?: unknown } | null;
    if (
      typeof b !== "object" ||
      b === null ||
      typeof b.key !== "string" ||
      !isSkillPackKey(b.key)
    )
      return { ok: false, error: usage };
    try {
      patchSkillPackKey(next, b.key, b.value ?? null, den);
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }
  for (const k of Object.keys(user)) delete user[k];
  Object.assign(user, next);
  return { ok: true };
}
