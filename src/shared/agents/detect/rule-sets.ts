/**
 * Issue 770: the screen rule sets Den ships, by id (each is
 * rules/<id>.toml). Apart from index.ts so the runtime catalog can check a
 * name without reading any file.
 */
export const RULE_SET_IDS = ["claude", "codex", "gemini", "grok"] as const;
export type RuleSetId = (typeof RULE_SET_IDS)[number];
