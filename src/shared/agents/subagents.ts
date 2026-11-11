/**
 * den#3 (3a): the model an agent's subagents run on. Claude Code's
 * subagents (the Agent tool's, Explore and general-purpose among them)
 * otherwise run on whatever their definition or the call says, often the
 * main model: most of an agent's calls on the costliest model.
 *
 * `agents.subagents.model` (org, default `sonnet`) and a persona's
 * `subagent_model` (wins) name it; `inherit` means none of Den's (the
 * runtime decides, as before). Den passes it forced, so every subagent,
 * Explore included, runs on it (den-claude: CLAUDE_CODE_SUBAGENT_MODEL
 * with CLAUDE_CODE_SUBAGENT_MODEL_FORCE).
 *
 * `agents.claude_ai_connectors` (default false): whether an agent loads
 * the account's claude.ai connectors. Off, an agent has Den's MCP only.
 */
const isMapping = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** "inherit": no subagent model of Den's. */
export const INHERIT = "inherit";

/** A model as `--model` takes it: an alias or a full id. */
export const SUBAGENT_MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._@:[\]-]{0,99}$/;

export interface SubagentSettings {
  /** The org's subagent model, or "inherit". */
  model: string;
  /** Whether agents load the account's claude.ai connectors. */
  claudeAiConnectors: boolean;
  /** The org config sets the model (even to the default's value). */
  modelSet?: true;
}

/** Where the org's model comes from: its config, or Den's default. */
export const orgModelFrom = (s: SubagentSettings): "org" | "default" =>
  s.modelSet || s.model !== SUBAGENT_DEFAULTS.model ? "org" : "default";

/** The oldest Claude Code that takes the subagent model forced. */
export const SUBAGENT_FORCE_MIN = "2.1.257";

/**
 * Whether Claude Code `version` ("2.1.322 (Claude Code)" or "2.1.322")
 * forces the subagent model: true, false (older: a fallback only), or
 * null when it can't be read.
 */
export function forcesSubagentModel(
  version: string | undefined,
): boolean | null {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(version ?? "");
  if (!m) return null;
  const want = SUBAGENT_FORCE_MIN.split(".").map(Number);
  const have = [Number(m[1]), Number(m[2]), Number(m[3])];
  for (let i = 0; i < 3; i++) if (have[i] !== want[i]) return have[i] > want[i];
  return true;
}

export const SUBAGENT_DEFAULTS: SubagentSettings = {
  model: "sonnet",
  claudeAiConnectors: false,
};

/** A subagent model value checked; throws naming `where`. */
export function checkSubagentModel(v: unknown, where: string): string {
  if (typeof v !== "string" || !SUBAGENT_MODEL_RE.test(v.trim()))
    throw new Error(
      `${where}: must be a model (sonnet, haiku, opus or a full model id) or inherit`,
    );
  return v.trim();
}

/** `agents.subagents` and `agents.claude_ai_connectors`, checked. */
export function subagentsBlock(
  subagents: unknown,
  connectors: unknown,
): SubagentSettings {
  const out = { ...SUBAGENT_DEFAULTS };
  if (subagents !== undefined && subagents !== null) {
    if (!isMapping(subagents))
      throw new Error(`agents.subagents: must be a mapping of model`);
    for (const k of Object.keys(subagents))
      if (k !== "model")
        throw new Error(
          `agents.subagents.${k}: unknown key (agents.subagents takes model)`,
        );
    if (subagents.model !== undefined && subagents.model !== null) {
      out.model = checkSubagentModel(subagents.model, "agents.subagents.model");
      out.modelSet = true;
    }
  }
  if (connectors !== undefined && connectors !== null) {
    if (typeof connectors !== "boolean")
      throw new Error(`agents.claude_ai_connectors: must be true or false`);
    out.claudeAiConnectors = connectors;
  }
  return out;
}

/** Where an agent's subagent model comes from, for doctor and the pane. */
export type SubagentModelFrom = "persona" | "org" | "default";

export interface EffectiveSubagentModel {
  /** The model, or undefined: the runtime decides (inherit). */
  model?: string;
  from: SubagentModelFrom;
}

/**
 * The persona's `subagent_model`, else the org's, else the default;
 * `inherit` at the level that decides means none.
 */
export function effectiveSubagentModel(
  persona: { subagentModel?: string },
  org: SubagentSettings | undefined,
): EffectiveSubagentModel {
  const [value, from]: [string, SubagentModelFrom] = persona.subagentModel
    ? [persona.subagentModel, "persona"]
    : org
      ? [org.model, orgModelFrom(org)]
      : [SUBAGENT_DEFAULTS.model, "default"];
  return value === INHERIT ? { from } : { model: value, from };
}
