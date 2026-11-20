/**
 * Issue 770: an agent's status (working, blocked, idle) from its screen,
 * for runtimes whose hooks don't say it (Codex, Gemini, Grok; Claude Code
 * when its hooks are off). The rule files in rules/ are herdr's
 * (Apache-2.0, THIRD_PARTY_NOTICES), shipped with each Den release and
 * read from the package: Den never fetches rules over the network.
 *
 * A runtime's catalog entry names its rule set (catalog.ts statusRules).
 * A screen no rule matches gives null: Den's bell and output signals
 * decide then, as before.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { enginePath } from "../../engine.js";
import { screenText } from "../trust-prompt.js";
import {
  compileRuleSet,
  detect,
  parseRuleSet,
  type CompiledRuleSet,
  type Detection,
  type DetectionInput,
} from "./engine.js";

import { RULE_SET_IDS } from "./rule-sets.js";

export type { AgentState, Detection, DetectionInput } from "./engine.js";
export { RULE_SET_IDS, type RuleSetId } from "./rule-sets.js";

/** Where the rule files ship (src/ ships whole). */
export const RULES_DIR = enginePath(
  "src",
  "shared",
  "agents",
  "detect",
  "rules",
);

const cache = new Map<string, CompiledRuleSet>();

/** Forget the rule sets read so far (tests). */
export function clearRuleSets(): void {
  cache.clear();
}

/** Rule set `id`, read from `dir` once and kept (throws when it is bad). */
export function ruleSet(id: string, dir = RULES_DIR): CompiledRuleSet {
  if (!(RULE_SET_IDS as readonly string[]).includes(id))
    throw new Error(`no status rules named ${JSON.stringify(id)}`);
  const key = `${dir}\0${id}`;
  let set = cache.get(key);
  if (!set) {
    const parsed = parseRuleSet(
      fs.readFileSync(path.join(dir, `${id}.toml`), "utf-8"),
    );
    if (parsed.id !== id)
      throw new Error(`rules/${id}.toml says it is ${parsed.id}`);
    set = compileRuleSet(parsed);
    cache.set(key, set);
  }
  return set;
}

// OSC 0 / 2 (the title) and OSC 9 (progress is 9;4;…), ended by BEL or ST.
// eslint-disable-next-line no-control-regex
const OSC = /\x1b\](\d+);([^\x07\x1b]*)(?:\x07|\x1b\\)/g;

/**
 * What the engine reads from a session's output (its raw bytes as text):
 * the screen drawn as text (screenText), the last title it set and its
 * last OSC 9;4 progress report.
 */
export function screenInput(output: string): DetectionInput {
  let oscTitle = "";
  let oscProgress = "";
  for (const m of output.matchAll(OSC)) {
    if (m[1] === "0" || m[1] === "2") oscTitle = m[2];
    else if (m[1] === "9" && /^4(?:;|$)/.test(m[2])) oscProgress = m[2];
  }
  return { screen: screenText(output), oscTitle, oscProgress };
}

/**
 * The status session output `output` shows by rule set `rules`, or null:
 * no rule set, a bad one (never thrown at a caller), or no rule matched.
 */
export function screenStatus(
  rules: string | undefined,
  output: string,
  dir = RULES_DIR,
): Detection | null {
  if (!rules || !output) return null;
  let set: CompiledRuleSet;
  try {
    set = ruleSet(rules, dir);
  } catch {
    return null;
  }
  return detect(set, screenInput(output));
}
