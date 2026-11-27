import {
  readAgentsConfig,
  type DenConfig,
  type LimitSource,
  type UserConfig,
} from "../../shared/den-config.js";
import {
  defaultSkills,
  parseAgentSkillPacks,
  resolveAgentPacks,
  skillsOf,
} from "../../shared/skill-packs/config.js";
import {
  readSkillPacksConfig,
  SKILL_PACKS_DIR,
} from "../../shared/skill-packs/launch.js";
import { readPacks, type Packs } from "../../shared/skill-packs/pin.js";
import {
  liveAgents,
  packsOffWhy,
  WHY,
  type PackAgent,
} from "./doctor-skill-packs.js";

const PACK_KEY =
  /^skill_packs\.(?:on|([a-z0-9][a-z0-9-]{0,63})\.(on|skills|exclude))$/;
const AGENT_KEY = /^agents\.([A-Za-z0-9][A-Za-z0-9_-]{0,63})\.skill_packs$/;

export const isSkillPackKey = (name: string): boolean =>
  PACK_KEY.test(name) || AGENT_KEY.test(name);

export function skillPackKeyNames(
  packs: Packs = readPacks(SKILL_PACKS_DIR),
): string[] {
  return [
    "skill_packs.on",
    ...Object.keys(packs)
      .sort()
      .flatMap((n) =>
        ["on", "skills", "exclude"].map((k) => `skill_packs.${n}.${k}`),
      ),
  ];
}

const pathOf = (name: string): string[] => name.split(".");

const isMapping = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function getIn(o: unknown, parts: readonly string[]): unknown {
  let at = o;
  for (const p of parts) {
    if (!isMapping(at)) return undefined;
    at = at[p];
  }
  return at;
}

function setIn(
  o: Record<string, unknown>,
  parts: readonly string[],
  v: unknown,
) {
  let at = o;
  for (const p of parts.slice(0, -1)) {
    if (!isMapping(at[p])) at[p] = {};
    at = at[p] as Record<string, unknown>;
  }
  const last = parts.at(-1)!;
  if (v === null || v === undefined) delete at[last];
  else at[last] = v;
  for (let n = parts.length - 1; n > 0; n--) {
    const parent = getIn(o, parts.slice(0, n - 1)) as Record<string, unknown>;
    const block = parent?.[parts[n - 1]!];
    if (isMapping(block) && !Object.keys(block).length)
      delete parent[parts[n - 1]!];
  }
}

export function patchSkillPackKey(
  user: Record<string, unknown>,
  name: string,
  value: unknown,
  den: DenConfig,
  packs: Packs = readPacks(SKILL_PACKS_DIR),
): void {
  const next = structuredClone(user);
  setIn(next, pathOf(name), value === "" ? null : value);
  const u = next as UserConfig;
  readSkillPacksConfig(den.skill_packs, u.skill_packs, packs);
  if (AGENT_KEY.test(name)) {
    readAgentsConfig(den, u);
    parseAgentSkillPacks(getIn(next, pathOf(name)), name, packs);
  }
  for (const k of Object.keys(user)) delete user[k];
  Object.assign(user, next);
}

const shown = (v: unknown): string =>
  Array.isArray(v) ? v.join(", ") : String(v);

export function skillPackValue(
  name: string,
  user: UserConfig,
  den: DenConfig,
): { value: string; from: LimitSource } {
  const parts = pathOf(name);
  const mine = getIn(user, parts);
  if (mine !== undefined && mine !== null)
    return { value: shown(mine), from: "user.yml" };
  const theirs = getIn(den, parts);
  if (theirs !== undefined && theirs !== null)
    return { value: shown(theirs), from: "den.yml" };
  const leaf = parts.at(-1);
  const value =
    leaf === "on"
      ? "true"
      : leaf === "skills"
        ? "all"
        : leaf === "exclude"
          ? ""
          : "default";
  return { value, from: "default" };
}

export function skillPacksSummary(
  user: UserConfig,
  den: DenConfig,
  deps: { packs?: Packs; agents?: () => PackAgent[] } = {},
): string[] {
  const packs = deps.packs ?? readPacks(SKILL_PACKS_DIR);
  const install = readSkillPacksConfig(
    den.skill_packs,
    user.skill_packs,
    packs,
  );
  const lines = [`skill packs: ${install.on ? "on" : "off"} for this install`];
  const on = new Map(
    resolveAgentPacks(install, undefined, undefined, packs).map((p) => [
      p.name,
      p.skills,
    ]),
  );
  for (const name of Object.keys(packs).sort()) {
    const pin = packs[name]!;
    const skills = on.get(name) ?? [];
    lines.push(
      `${name}: ${pin.license}, pinned at ${pin.commit.slice(0, 7)} · skills on: ${skills.length} of ${skillsOf(pin).length} (default ${defaultSkills(pin).length})`,
    );
  }
  let agents: PackAgent[] = [];
  try {
    agents = (deps.agents ?? liveAgents)();
  } catch {
    agents = [];
  }
  const seen = new Set(agents.map((a) => a.id));
  const configured = readAgentsConfig(den, user).agents;
  for (const [id, a] of Object.entries(configured))
    if (!seen.has(id) && a?.skillPacks !== undefined)
      agents.push({
        id,
        workspace: "",
        persona: undefined,
        agent: a.skillPacks,
      });
  const off: string[] = [];
  for (const a of agents) {
    const why = packsOffWhy(install, a.persona, a.agent, packs);
    if (why)
      off.push(
        `  ${a.workspace ? `${a.workspace}/` : ""}${a.id}: set by ${WHY[why]}`,
      );
  }
  lines.push(
    off.length ? "agents with packs off:" : "agents with packs off: none",
    ...off,
  );
  return lines;
}
