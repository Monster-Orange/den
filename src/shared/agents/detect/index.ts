/**
 * Issue 770: the screen rule sets Den ships, by name, and how a screen's
 * reading combines with hook status. The rules are files in ./rules,
 * vendored per release: nothing here reads the network.
 */
import { detect, type Detection, type RuleSet, type Screen } from "./engine.js";
import { CLAUDE_RULES } from "./rules/claude.js";
import { CODEX_RULES } from "./rules/codex.js";
import { GEMINI_RULES } from "./rules/gemini.js";
import { GROK_RULES } from "./rules/grok.js";

export {
  detect,
  region,
  ruleSetProblems,
  toRegExp,
  ENGINE_VERSION,
  type Detection,
  type Rule,
  type RuleSet,
  type Screen,
  type ScreenState,
} from "./engine.js";

/** Every rule set, by the name a catalog entry's `screenRules` gives. */
export const RULE_SETS: Readonly<Record<string, RuleSet>> = {
  claude: CLAUDE_RULES,
  codex: CODEX_RULES,
  gemini: GEMINI_RULES,
  grok: GROK_RULES,
};

/** The rule set a name gives, if Den ships it. */
export function ruleSet(name: string | undefined): RuleSet | undefined {
  return name && Object.hasOwn(RULE_SETS, name) ? RULE_SETS[name] : undefined;
}

/** What Den shows for an agent: working, needs you, or idle. */
export type AgentStatus = "working" | "blocked" | "idle";

/**
 * An agent's status. Hook status, when the runtime reports one (Claude
 * with Den's hooks on), wins over the screen. Otherwise the screen's
 * reading, unless it says nothing new: no rule matched (`fallback`), a
 * transcript viewer is up (`skip`), or the state is unknown. Then
 * undefined: the caller keeps what it has (the bell, output stopped).
 */
export function agentStatus(
  hook: AgentStatus | undefined,
  screen: Detection | undefined,
): AgentStatus | undefined {
  if (hook) return hook;
  if (!screen || screen.fallback || screen.skip) return undefined;
  return screen.state === "unknown" ? undefined : screen.state;
}

/** A named rule set's reading of a screen; undefined with no such set. */
export function detectScreen(
  name: string | undefined,
  screen: Screen,
): Detection | undefined {
  const set = ruleSet(name);
  return set ? detect(set, screen) : undefined;
}
