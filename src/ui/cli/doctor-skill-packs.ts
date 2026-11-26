import os from "node:os";
import path from "node:path";
import {
  parseAgentSkillPacks,
  resolveAgentPacks,
  type SkillPacksConfig,
} from "../../shared/skill-packs/config.js";
import {
  personOwnPlugins,
  readSkillPacksConfig,
  SKILL_PACKS_DIR,
} from "../../shared/skill-packs/launch.js";
import {
  readPacks,
  verifyPack,
  type Packs,
} from "../../shared/skill-packs/pin.js";
import { readAgentsConfig } from "../../shared/den-config.js";
import { getStateDir } from "../../shared/paths.js";
import { listRecords } from "../../shared/agents/records.js";
import { personaLookup, resolveAgentsDeps } from "./agent-ops.js";
import type { OnboardCheck } from "./doctor-onboard.js";

export interface PackAgent {
  id: string;
  workspace: string;
  persona: unknown;
  agent: unknown;
}

export interface SkillPackDoctorDeps {
  packsDir?: string;
  install?: () => SkillPacksConfig;
  agents?: () => PackAgent[];
  claudeConfigDir?: string;
}

export const WHY = {
  agent: "the agent",
  persona: "its persona",
  install: "the install",
} as const;

export function packsOffWhy(
  install: SkillPacksConfig,
  persona: unknown,
  agent: unknown,
  packs: Packs,
): keyof typeof WHY | null {
  const p = parseAgentSkillPacks(persona, "the persona's skill_packs", packs);
  const a = parseAgentSkillPacks(agent, "the agent's skill_packs", packs);
  if (resolveAgentPacks(install, p, a, packs).length) return null;
  if (!resolveAgentPacks(install, undefined, undefined, packs).length)
    return "install";
  if (a && a.mode !== "on") return "agent";
  return p ? "persona" : "install";
}

export function liveAgents(): PackAgent[] {
  const cfg = readAgentsConfig();
  const find = personaLookup(resolveAgentsDeps({}));
  return listRecords(getStateDir())
    .filter((r) => !r.stoppedAt)
    .map((r) => ({
      id: r.id,
      workspace: r.workspace,
      persona: find(r)?.skillPacks,
      agent: cfg.agents[r.id]?.skillPacks,
    }));
}

function liveInstall(): SkillPacksConfig {
  const cfg = readAgentsConfig();
  return readSkillPacksConfig(cfg.skillPacks?.den, cfg.skillPacks?.user);
}

export function skillPackLines(
  title: string,
  deps: SkillPackDoctorDeps = {},
): { lines: string[]; checks: OnboardCheck[] } {
  const packsDir = deps.packsDir ?? SKILL_PACKS_DIR;
  const head = ["", `${title} doctor: Skill packs`, ""];
  let packs: Packs;
  let install: SkillPacksConfig;
  try {
    packs = readPacks(packsDir);
    install = (deps.install ?? liveInstall)();
  } catch (e) {
    const detail = `skill packs: ${(e as Error).message}`;
    return {
      lines: [...head, `  skill packs  ✗  ${detail}`],
      checks: [{ id: "skill-packs", status: "fail", detail }],
    };
  }
  const lines: string[] = [];
  const checks: OnboardCheck[] = [];
  const own = new Set(
    personOwnPlugins(
      deps.claudeConfigDir ??
        process.env.CLAUDE_CONFIG_DIR ??
        path.join(os.homedir(), ".claude"),
    ),
  );
  for (const name of Object.keys(packs).sort()) {
    const pin = packs[name]!;
    const problems = verifyPack(path.join(packsDir, name), pin);
    const at = `${name} pinned at ${pin.commit.slice(0, 7)}`;
    if (problems.length) {
      const detail = `${at}: ${problems.slice(0, 3).join("; ")}${problems.length > 3 ? `; and ${problems.length - 3} more` : ""}`;
      lines.push(`  ${name}  ✗  ${detail}`);
      checks.push({
        id: `skill-packs:pack:${name}`,
        status: "fail",
        detail,
        fix: "Reinstall Den: its copy of the pack doesn't match the pin",
      });
    } else {
      const detail = `${at}: ${Object.keys(pin.files).length} files match the pin, MIT licence present`;
      lines.push(`  ${name}  ✓  ${detail}`);
      checks.push({ id: `skill-packs:pack:${name}`, status: "ok", detail });
    }
    const copy = own.has(name)
      ? `${name}: your own ${name} plugin from Claude Code is in use, not Den's copy`
      : `${name}: Den's own copy is in use`;
    lines.push(`  ${name}  ·  ${copy}`);
    checks.push({ id: `skill-packs:copy:${name}`, status: "ok", detail: copy });
  }
  let agents: PackAgent[] = [];
  try {
    agents = (deps.agents ?? liveAgents)();
  } catch {
    agents = [];
  }
  for (const a of agents) {
    const who = `${a.workspace}/${a.id}`;
    let why: keyof typeof WHY | null;
    try {
      why = packsOffWhy(install, a.persona, a.agent, packs);
    } catch (e) {
      const detail = `${who}: ${(e as Error).message}`;
      lines.push(`  agent  ⚠  ${detail}`);
      checks.push({ id: `skill-packs:off:${who}`, status: "warn", detail });
      continue;
    }
    if (!why) continue;
    const detail = `${who}: skill packs off, set by ${WHY[why]}`;
    lines.push(`  agent  ·  ${detail}`);
    checks.push({ id: `skill-packs:off:${who}`, status: "ok", detail });
  }
  return { lines: [...head, ...lines], checks };
}
