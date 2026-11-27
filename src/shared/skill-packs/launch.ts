import fs from "node:fs";
import path from "node:path";
import { enginePath } from "../engine.js";
import { buildPluginDir, SKILL_PACK_CACHE } from "./build.js";
import {
  parseAgentSkillPacks,
  parseSkillPacks,
  resolveAgentPacks,
  type SkillPacksConfig,
} from "./config.js";
import { readPacks, type Packs } from "./pin.js";

export const SKILL_PACKS_DIR = enginePath("skill-packs");
export const SKILL_PACK_RUNTIMES = ["den-claude"];

const isMapping = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function mergeByKey(den: unknown, user: unknown): unknown {
  if (!isMapping(den) || !isMapping(user)) return user ?? den;
  const out: Record<string, unknown> = { ...den };
  for (const [k, v] of Object.entries(user))
    out[k] = isMapping(v) && isMapping(den[k]) ? { ...den[k], ...v } : v;
  return out;
}

export function readSkillPacksConfig(
  den: unknown,
  user: unknown,
  packs: Packs = readPacks(SKILL_PACKS_DIR),
): SkillPacksConfig {
  parseSkillPacks(den, "den.yml skill_packs", packs);
  parseSkillPacks(user, "user.yml skill_packs", packs);
  return parseSkillPacks(mergeByKey(den, user), "skill_packs", packs);
}

export function personOwnPlugins(claudeConfigDir: string): string[] {
  try {
    const raw: unknown = JSON.parse(
      fs.readFileSync(
        path.join(claudeConfigDir, "plugins", "installed_plugins.json"),
        "utf8",
      ),
    );
    const plugins = isMapping(raw) ? raw.plugins : undefined;
    if (!isMapping(plugins)) return [];
    return [...new Set(Object.keys(plugins).map((k) => k.split("@")[0]!))];
  } catch {
    return [];
  }
}

export interface AgentSkillPacksInput {
  stateDir: string;
  runtimeId: string;
  install: SkillPacksConfig;
  persona: unknown;
  agent: unknown;
  claudeConfigDir: string;
  packsDir?: string;
}

export function agentSkillPacks(o: AgentSkillPacksInput): {
  packs: { name: string; dir: string }[];
  note?: string;
} {
  const packsDir = o.packsDir ?? SKILL_PACKS_DIR;
  const packs = readPacks(packsDir);
  const chosen = resolveAgentPacks(
    o.install,
    parseAgentSkillPacks(o.persona, "the persona's skill_packs", packs),
    parseAgentSkillPacks(o.agent, "the agent's skill_packs", packs),
    packs,
  );
  if (!chosen.length) return { packs: [] };
  if (!SKILL_PACK_RUNTIMES.includes(o.runtimeId))
    return { packs: [], note: "Skill packs: Not used by this runtime." };
  const own = new Set(personOwnPlugins(o.claudeConfigDir));
  const mine = chosen.filter((p) => own.has(p.name));
  const cache = path.join(o.stateDir, SKILL_PACK_CACHE);
  return {
    packs: chosen
      .filter((p) => !own.has(p.name))
      .map((p) => ({
        name: p.name,
        dir: buildPluginDir(packsDir, cache, p.name, packs[p.name]!, p.skills),
      })),
    ...(mine.length
      ? {
          note: `Skill packs: using your own ${mine.map((p) => p.name).join(", ")} from Claude Code, not Den's copy.`,
        }
      : {}),
  };
}
