/*
 * SPDX-License-Identifier: Apache-2.0
 * Origin: herdr (https://github.com/herdrdev/herdr), src/detect/manifest.rs
 *   at e8d7d9705a7a2c89cef4dd42079379f05685af87
 * Copyright (c) the herdr authors. Licensed under the Apache License,
 * Version 2.0 (http://www.apache.org/licenses/LICENSE-2.0); see
 * THIRD_PARTY_NOTICES at the root of this repository.
 * Modified by Den: ported from Rust to TypeScript. Only the rule format,
 * the regions, the matchers and the priority pick are kept; remote rule
 * updates and local overrides are left out (Den ships its rules with each
 * release), and a screen no rule matches gives null (Den's own bell and
 * output signals decide), not herdr's "idle".
 */
/**
 * Issue 770: the screen rule engine. A rule set is a list of rules; each
 * rule names a state (working, blocked, idle, or unknown), a priority, a
 * region of the screen to read, and matchers on that region:
 *
 *   contains     every string is in the region (case-insensitive)
 *   regex        every pattern matches the region (Rust regex syntax,
 *                translated: rustRegex)
 *   line_regex   every pattern matches some one line of the region
 *   all          every nested gate matches
 *   any          at least one nested gate matches
 *   not          no nested gate matches
 *
 * The highest priority matching rule wins (the first one on a tie). A
 * rule with skip_state_update (a transcript viewer on screen) wins like
 * any other, and says the agent's state stays what it was. Pure.
 */
import { parseToml, type TomlTable, type TomlValue } from "./toml.js";

export const AGENT_STATES = ["idle", "working", "blocked", "unknown"] as const;
export type AgentState = (typeof AGENT_STATES)[number];

/** What the engine reads: the screen as text, and the terminal's OSC strings. */
export interface DetectionInput {
  /** The screen's rows as text, one per line (no escapes). */
  screen: string;
  /** The terminal title (the last OSC 0 or 2), or "". */
  oscTitle: string;
  /** The last OSC 9;4 progress report, after "9;" ("4;1;-1"), or "". */
  oscProgress: string;
}

export interface Gate {
  all: Gate[];
  any: Gate[];
  not: Gate[];
  contains: string[];
  regex: string[];
  line_regex: string[];
}

export interface Rule extends Gate {
  id: string;
  state: AgentState;
  priority: number;
  region: string;
  visible_idle: boolean;
  visible_blocker: boolean;
  visible_working: boolean;
  skip_state_update: boolean;
}

export interface RuleSet {
  id: string;
  version?: string;
  aliases: string[];
  rules: Rule[];
}

interface CompiledGate {
  all: CompiledGate[];
  any: CompiledGate[];
  not: CompiledGate[];
  contains: string[];
  regex: RegExp[];
  lineRegex: RegExp[];
}

export interface CompiledRuleSet {
  set: RuleSet;
  gates: CompiledGate[];
}

/** What a screen says, by the rule that won. */
export interface Detection {
  state: AgentState;
  rule: string;
  priority: number;
  /** Leave the agent's state as it was (a transcript viewer on screen). */
  skipStateUpdate: boolean;
  visibleBlocker: boolean;
  visibleWorking: boolean;
  visibleIdle: boolean;
}

const MAX_RULES = 128;
const MAX_GATE_DEPTH = 8;
const MAX_TOTAL_GATES = 512;
const MAX_MATCHERS_PER_GATE = 32;
const MAX_TOTAL_MATCHERS = 1024;
const MAX_MATCHER_CHARS = 512;

const NAMED_REGIONS = [
  "whole_recent",
  "after_last_prompt_marker",
  "before_current_prompt_marker",
  "whole_recent_without_current_prompt_marker",
  "current_prompt_block_marker",
  "after_current_prompt_block_marker",
  "prompt_box_body",
  "above_prompt_box",
  "last_non_empty_above_prompt_box",
  "after_last_horizontal_rule",
  "osc_title",
  "osc_progress",
];

const RULE_KEYS = [
  "id",
  "state",
  "priority",
  "region",
  "visible_idle",
  "visible_blocker",
  "visible_working",
  "skip_state_update",
  "all",
  "any",
  "not",
  "contains",
  "regex",
  "line_regex",
];
const GATE_KEYS = ["all", "any", "not", "contains", "regex", "line_regex"];
const SET_KEYS = [
  "id",
  "version",
  "min_engine_version",
  "updated_at",
  "aliases",
  "rules",
];

/**
 * A Rust `regex` pattern as a JavaScript RegExp (the u flag on): leading
 * inline flags (?i) (?m) (?s) become flags, \A and \z become their
 * lookarounds, \x{HHHH} becomes \u{HHHH}. Anything the translation can't
 * carry (another inline flag, \Z) is an error.
 */
export function rustRegex(pattern: string): RegExp {
  let src = pattern;
  let flags = "u";
  for (let m = /^\(\?([a-zA-Z]+)\)/.exec(src); m; ) {
    for (const f of m[1]) {
      if (!"ims".includes(f))
        throw new Error(`regex ${pattern}: inline flag ${f} isn't supported`);
      if (!flags.includes(f)) flags += f;
    }
    src = src.slice(m[0].length);
    m = /^\(\?([a-zA-Z]+)\)/.exec(src);
  }
  let out = "";
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "(" && src[i + 1] === "?" && /[a-zA-Z]/.test(src[i + 2] ?? ""))
      throw new Error(`regex ${pattern}: inline flags only at the start`);
    if (c !== "\\") {
      out += c;
      continue;
    }
    const n = src[i + 1];
    if (n === "A") out += "(?<![\\s\\S])";
    else if (n === "z") out += "(?![\\s\\S])";
    else if (n === "Z")
      throw new Error(`regex ${pattern}: \\Z isn't supported`);
    else if (n === "x" && src[i + 2] === "{") {
      const end = src.indexOf("}", i + 3);
      if (end < 0) throw new Error(`regex ${pattern}: bad \\x{…}`);
      out += `\\u{${src.slice(i + 3, end)}}`;
      i = end;
      continue;
    } else out += c + (n ?? "");
    i++;
  }
  return new RegExp(out, flags);
}

function strings(where: string, v: TomlValue | undefined): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string"))
    throw new Error(`${where}: must be a list of strings`);
  return v as string[];
}

function bool(where: string, v: TomlValue | undefined): boolean {
  if (v === undefined) return false;
  if (typeof v !== "boolean")
    throw new Error(`${where}: must be true or false`);
  return v;
}

function table(where: string, v: TomlValue): TomlTable {
  if (typeof v !== "object" || v === null || Array.isArray(v))
    throw new Error(`${where}: must be a table`);
  return v;
}

function onlyKeys(where: string, t: TomlTable, keys: string[]): void {
  for (const k of Object.keys(t))
    if (!keys.includes(k)) throw new Error(`${where}: unknown key ${k}`);
}

function gates(where: string, v: TomlValue | undefined): Gate[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) throw new Error(`${where}: must be a list of gates`);
  return v.map((g, i) => gateOf(`${where}[${i}]`, table(`${where}[${i}]`, g)));
}

function gateOf(where: string, t: TomlTable): Gate {
  onlyKeys(where, t, GATE_KEYS);
  return {
    all: gates(`${where}.all`, t.all),
    any: gates(`${where}.any`, t.any),
    not: gates(`${where}.not`, t.not),
    contains: strings(`${where}.contains`, t.contains),
    regex: strings(`${where}.regex`, t.regex),
    line_regex: strings(`${where}.line_regex`, t.line_regex),
  };
}

/** Whether `spec` names a region the engine reads. */
export function validRegion(spec: string): boolean {
  const s = spec.trim();
  if (NAMED_REGIONS.includes(s)) return true;
  return (
    regionCount(s, "bottom_lines") !== null ||
    regionCount(s, "bottom_non_empty_lines") !== null ||
    topRegionCount(s) !== null
  );
}

const positive = (g: Gate): boolean =>
  g.contains.length > 0 ||
  g.regex.length > 0 ||
  g.line_regex.length > 0 ||
  g.all.length > 0 ||
  g.any.length > 0;

function checkGate(
  g: Gate,
  where: string,
  depth: number,
  inNot: boolean,
  n: { gates: number; matchers: number },
): void {
  if (depth > MAX_GATE_DEPTH)
    throw new Error(`${where}: deeper than ${MAX_GATE_DEPTH} gates`);
  if (++n.gates > MAX_TOTAL_GATES)
    throw new Error(`more than ${MAX_TOTAL_GATES} gates`);
  const direct = [...g.contains, ...g.regex, ...g.line_regex];
  if (direct.length > MAX_MATCHERS_PER_GATE)
    throw new Error(`${where}: more than ${MAX_MATCHERS_PER_GATE} matchers`);
  n.matchers += direct.length;
  if (n.matchers > MAX_TOTAL_MATCHERS)
    throw new Error(`more than ${MAX_TOTAL_MATCHERS} matchers`);
  for (const m of direct)
    if (Array.from(m).length > MAX_MATCHER_CHARS)
      throw new Error(`${where}: a matcher over ${MAX_MATCHER_CHARS} chars`);
  if (inNot ? !positive(g) && !g.not.length : !positive(g))
    throw new Error(`${where}: needs a positive matcher`);
  for (const p of [...g.regex, ...g.line_regex]) rustRegex(p);
  for (const x of g.all) checkGate(x, where, depth + 1, inNot, n);
  for (const x of g.any) checkGate(x, where, depth + 1, inNot, n);
  for (const x of g.not) checkGate(x, where, depth + 1, true, n);
}

/** A rule file's text as a checked rule set (throws on anything wrong). */
export function parseRuleSet(text: string): RuleSet {
  const doc = parseToml(text);
  onlyKeys("rule set", doc, SET_KEYS);
  if (typeof doc.id !== "string" || !doc.id.trim())
    throw new Error("rule set: id must be a name");
  const raw = doc.rules;
  if (!Array.isArray(raw) || raw.length === 0)
    throw new Error("rule set: must have at least one rule");
  if (raw.length > MAX_RULES)
    throw new Error(`rule set: more than ${MAX_RULES} rules`);
  const count = { gates: 0, matchers: 0 };
  const rules = raw.map((r, i): Rule => {
    const t = table(`rules[${i}]`, r);
    onlyKeys(`rules[${i}]`, t, RULE_KEYS);
    if (typeof t.id !== "string" || !t.id.trim())
      throw new Error(`rules[${i}]: id must be a name`);
    const where = `rule ${t.id}`;
    const state = t.state ?? "unknown";
    if (!(AGENT_STATES as readonly unknown[]).includes(state))
      throw new Error(`${where}: state must be one of ${AGENT_STATES}`);
    const priority = t.priority ?? 0;
    if (typeof priority !== "number" || !Number.isInteger(priority))
      throw new Error(`${where}: priority must be a whole number`);
    const region = t.region ?? "whole_recent";
    if (typeof region !== "string" || !validRegion(region))
      throw new Error(`${where}: unknown region ${String(region)}`);
    const rule: Rule = {
      id: t.id,
      state: state as AgentState,
      priority,
      region,
      visible_idle: bool(`${where}.visible_idle`, t.visible_idle),
      visible_blocker: bool(`${where}.visible_blocker`, t.visible_blocker),
      visible_working: bool(`${where}.visible_working`, t.visible_working),
      skip_state_update: bool(
        `${where}.skip_state_update`,
        t.skip_state_update,
      ),
      ...gateOf(where, {
        ...(t.all !== undefined ? { all: t.all } : {}),
        ...(t.any !== undefined ? { any: t.any } : {}),
        ...(t.not !== undefined ? { not: t.not } : {}),
        ...(t.contains !== undefined ? { contains: t.contains } : {}),
        ...(t.regex !== undefined ? { regex: t.regex } : {}),
        ...(t.line_regex !== undefined ? { line_regex: t.line_regex } : {}),
      }),
    };
    if (rule.skip_state_update) {
      if (rule.state !== "unknown")
        throw new Error(`${where}: skip_state_update needs state "unknown"`);
      if (rule.visible_idle || rule.visible_blocker || rule.visible_working)
        throw new Error(`${where}: skip_state_update with a visible state`);
    }
    checkGate(rule, where, 0, false, count);
    return rule;
  });
  return {
    id: doc.id.trim(),
    ...(typeof doc.version === "string" ? { version: doc.version } : {}),
    aliases: strings("rule set.aliases", doc.aliases),
    rules,
  };
}

function compileGate(g: Gate): CompiledGate {
  return {
    all: g.all.map(compileGate),
    any: g.any.map(compileGate),
    not: g.not.map(compileGate),
    contains: g.contains.map((s) => s.toLowerCase()),
    regex: g.regex.map(rustRegex),
    lineRegex: g.line_regex.map(rustRegex),
  };
}

export function compileRuleSet(set: RuleSet): CompiledRuleSet {
  return { set, gates: set.rules.map(compileGate) };
}

/** Rust's str::lines: split on \n, a trailing \r dropped, no last empty line. */
export function rustLines(s: string): string[] {
  if (s === "") return [];
  const out = s.split("\n");
  if (out[out.length - 1] === "") out.pop();
  return out.map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
}

function gateMatches(g: CompiledGate, text: string, lower: string): boolean {
  if (!g.contains.every((n) => lower.includes(n))) return false;
  if (!g.regex.every((r) => r.test(text))) return false;
  if (g.lineRegex.length) {
    const lines = rustLines(text);
    if (!g.lineRegex.every((r) => lines.some((l) => r.test(l)))) return false;
  }
  if (!g.all.every((x) => gateMatches(x, text, lower))) return false;
  if (g.any.length && !g.any.some((x) => gateMatches(x, text, lower)))
    return false;
  if (g.not.some((x) => gateMatches(x, text, lower))) return false;
  return true;
}

/**
 * The state the screen shows by `rules`: the highest priority rule that
 * matches (the first on a tie), or null when none does (Den's own signals
 * decide then).
 */
export function detect(
  rules: CompiledRuleSet,
  input: DetectionInput,
): Detection | null {
  let best: { rule: Rule } | null = null;
  rules.set.rules.forEach((rule, i) => {
    const text = region(input, rule.region);
    if (!gateMatches(rules.gates[i], text, text.toLowerCase())) return;
    if (best && best.rule.priority >= rule.priority) return;
    best = { rule };
  });
  if (!best) return null;
  const { rule } = best as { rule: Rule };
  return {
    state: rule.state,
    rule: rule.id,
    priority: rule.priority,
    skipStateUpdate: rule.skip_state_update,
    visibleBlocker: rule.visible_blocker && rule.state === "blocked",
    visibleWorking: rule.visible_working && rule.state === "working",
    visibleIdle: rule.visible_idle && rule.state === "idle",
  };
}

// The regions. Offsets are string indices, lines as rustLines reads them.

/** The text of region `spec` of the input ("" for an unknown region). */
export function region(input: DetectionInput, spec: string): string {
  const s = spec.trim();
  if (s === "osc_title") return input.oscTitle;
  if (s === "osc_progress") return input.oscProgress;
  const c = input.screen;
  switch (s) {
    case "whole_recent":
      return c;
    case "after_last_prompt_marker":
      return afterLastPromptMarker(c);
    case "before_current_prompt_marker":
      return beforeCurrentPromptMarker(c);
    case "whole_recent_without_current_prompt_marker":
      return currentPromptIndex(rustLines(c)) === null ? c : "";
    case "current_prompt_block_marker":
      return currentPromptBlockMarker(c) ?? "";
    case "after_current_prompt_block_marker":
      return afterCurrentPromptBlockMarker(c) ?? "";
    case "prompt_box_body":
      return promptBoxBody(c) ?? "";
    case "above_prompt_box":
      return abovePromptBox(c);
    case "last_non_empty_above_prompt_box":
      return lastNonEmptyLine(abovePromptBox(c));
    case "after_last_horizontal_rule":
      return afterLastHorizontalRule(c);
  }
  const bottom = regionCount(s, "bottom_lines");
  if (bottom !== null) return bottomLines(c, bottom);
  const bottomNonEmpty = regionCount(s, "bottom_non_empty_lines");
  if (bottomNonEmpty !== null) return bottomNonEmptyLines(c, bottomNonEmpty);
  const top = topRegionCount(s);
  if (top !== null) return topNonEmptyLines(c, top);
  return "";
}

function regionCount(spec: string, name: string): number | null {
  const m = new RegExp(`^${name}\\((\\d+)\\)$`).exec(spec);
  return m ? Number(m[1]) : null;
}

function topRegionCount(spec: string): number | null {
  const m = /^top_non_empty_lines\(([1-9]\d*)\)$/.exec(spec);
  if (!m) return null;
  const n = Number(m[1]);
  return n <= 0xffff ? n : null;
}

function lineStart(content: string, lines: string[], index: number): number {
  let at = 0;
  for (const l of lines.slice(0, Math.min(index, lines.length)))
    at += l.length + 1;
  return Math.min(at, content.length);
}

function fromLine(content: string, lines: string[], index: number): string {
  return content.slice(lineStart(content, lines, index));
}

function bottomLines(content: string, count: number): string {
  const lines = rustLines(content);
  return fromLine(content, lines, Math.max(0, lines.length - count));
}

function bottomNonEmptyLines(content: string, count: number): string {
  const lines = rustLines(content);
  let seen = 0;
  let start = -1;
  for (let i = lines.length - 1; i >= 0 && seen < count; i--)
    if (lines[i].trim()) {
      seen++;
      start = i;
    }
  return start < 0 ? "" : fromLine(content, lines, start);
}

function topNonEmptyLines(content: string, count: number): string {
  const lines = rustLines(content);
  let seen = 0;
  let end = -1;
  for (let i = 0; i < lines.length && seen < count; i++)
    if (lines[i].trim()) {
      seen++;
      end = i;
    }
  return end < 0 ? "" : content.slice(0, lineStart(content, lines, end + 1));
}

const promptLine = (l: string): boolean => l === "›" || l.startsWith("› ");
const blockMarkerLine = (l: string): boolean => /^[•■✗✓]/u.test(l);

function lastIndex(lines: string[], f: (l: string) => boolean, end?: number) {
  for (let i = (end ?? lines.length) - 1; i >= 0; i--)
    if (f(lines[i])) return i;
  return null;
}

function afterLastPromptMarker(content: string): string {
  const lines = rustLines(content);
  const i = lastIndex(lines, promptLine);
  return i === null ? content : fromLine(content, lines, i + 1);
}

function currentPromptIndex(lines: string[]): number | null {
  const i = lastIndex(lines, promptLine);
  if (i === null) return null;
  return lines.slice(i + 1).some(blockMarkerLine) ? null : i;
}

function beforeCurrentPromptMarker(content: string): string {
  const lines = rustLines(content);
  const i = currentPromptIndex(lines);
  return i === null ? content : content.slice(0, lineStart(content, lines, i));
}

function currentPromptBlockMarker(content: string): string | null {
  const lines = rustLines(content);
  const p = currentPromptIndex(lines);
  if (p === null) return null;
  const b = lastIndex(lines, blockMarkerLine, p);
  return b === null ? null : lines[b];
}

function afterCurrentPromptBlockMarker(content: string): string | null {
  const lines = rustLines(content);
  const p = currentPromptIndex(lines);
  if (p === null) return null;
  const b = lastIndex(lines, blockMarkerLine, p);
  return b === null ? null : fromLine(content, lines, b);
}

function isHorizontalRule(line: string): boolean {
  const t = line.trim();
  if (!t) return false;
  const chars = Array.from(t);
  let n = 0;
  while (n < chars.length && chars[n] === "─") n++;
  if (n === 0) return false;
  return !chars.slice(n).join("").trimStart() || n >= 3;
}

function promptBoxTop(lines: string[]): number | null {
  let borders = 0;
  for (let i = lines.length - 1; i >= 0; i--)
    if (isHorizontalRule(lines[i]) && ++borders === 2) return i;
  return null;
}

function promptBoxBody(content: string): string | null {
  const lines = rustLines(content);
  const top = promptBoxTop(lines);
  if (top === null) return null;
  let end = lines.length;
  for (let i = top + 1; i < lines.length; i++)
    if (isHorizontalRule(lines[i])) {
      end = i;
      break;
    }
  return content.slice(
    lineStart(content, lines, top + 1),
    lineStart(content, lines, end),
  );
}

function abovePromptBox(content: string): string {
  const lines = rustLines(content);
  const top = promptBoxTop(lines);
  return top === null
    ? content
    : content.slice(0, lineStart(content, lines, top));
}

function afterLastHorizontalRule(content: string): string {
  let lastEnd = 0;
  let at = 0;
  for (const l of rustLines(content)) {
    const next = at + l.length + 1;
    if (isHorizontalRule(l)) lastEnd = Math.min(next, content.length);
    at = next;
  }
  return content.slice(lastEnd);
}

function lastNonEmptyLine(content: string): string {
  const lines = rustLines(content);
  for (let i = lines.length - 1; i >= 0; i--)
    if (lines[i].trim()) return lines[i];
  return "";
}
