/**
 * Issue 770: the screen rule sets Den ships, by name, and how a screen's
 * reading combines with hook status. The rules are files in ./rules,
 * vendored per release: nothing here reads the network.
 */
import {
  detect,
  type DetectLimits,
  type Detection,
  type RuleSet,
  type Screen,
} from "./engine.js";
import { CLAUDE_RULES } from "./rules/claude.js";
import { CODEX_RULES } from "./rules/codex.js";
import { GEMINI_RULES } from "./rules/gemini.js";
import { GROK_RULES } from "./rules/grok.js";
import { ANTIGRAVITY_RULES } from "./rules/antigravity.js";
import type { StatusState } from "../../sessions/bell.js";

export {
  detect,
  region,
  ruleSetProblems,
  toRegExp,
  ENGINE_VERSION,
  DETECT_LIMITS,
  boundScreen,
  type DetectLimits,
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
  antigravity: ANTIGRAVITY_RULES,
};

/** The rule set a name gives, if Den ships it. */
export function ruleSet(name: string | undefined): RuleSet | undefined {
  return name && Object.hasOwn(RULE_SETS, name) ? RULE_SETS[name] : undefined;
}

/** What Den shows for an agent: working, needs you, or idle. */
export type AgentStatus = "working" | "blocked" | "idle";

export interface TermStatus {
  state: StatusState;
  at: string;
}

/**
 */
export function fromTerm(state: StatusState): {
  status: AgentStatus;
  finished: boolean;
} {
  switch (state) {
    case "working":
      return { status: "working", finished: false };
    case "blocked":
    case "error":
      return { status: "blocked", finished: false };
    case "done":
      return { status: "idle", finished: true };
    default:
      return { status: "idle", finished: false };
  }
}

function said(screen: Detection | undefined): AgentStatus | undefined {
  if (!screen || screen.fallback || screen.skip) return undefined;
  return screen.state === "unknown" ? undefined : screen.state;
}

export function agentStatus(input: {
  hook?: AgentStatus;
  term?: TermStatus;
  screen?: Detection;
  screenAt?: string;
}): AgentStatus | undefined {
  if (input.hook) return input.hook;
  const seen = said(input.screen);
  if (input.term) {
    const t = fromTerm(input.term.state).status;
    const later =
      input.screenAt !== undefined &&
      Date.parse(input.screenAt) > Date.parse(input.term.at);
    // A 7501 only raises: a screen's blocked wins, a later screen lowers it.
    if (seen === "blocked") return seen;
    if (!seen || seen === t || !later) return t;
  }
  return seen;
}

/** A named rule set's reading of a screen; undefined with no such set. */
export function detectScreen(
  name: string | undefined,
  screen: Screen,
  limits?: DetectLimits,
): Detection | undefined {
  const set = ruleSet(name);
  return set ? detect(set, screen, limits) : undefined;
}
