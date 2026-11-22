/**
 * Issue 770: an agent's state (working, blocked, idle) read from its
 * screen, by a runtime's rule set (./rules). A port of herdr's detection
 * engine (https://github.com/herdrdev/herdr, src/detect/manifest.rs at
 * commit e8d7d9705a7a2c89cef4dd42079379f05685af87): its regions, its
 * matchers and how it picks a rule.
 *
 * Copyright 2026 the herdr authors. Licensed under the Apache License,
 * Version 2.0; see THIRD_PARTY_NOTICES at the repository root.
 * Modified by Den: rewritten in TypeScript; regexes are translated from
 * Rust's to JavaScript's (toRegExp); a screen no rule matches says so
 * (`fallback`), so Den's callers keep the bell and output-stopped signals
 * there.
 *
 * herdr-origin: src/detect/manifest.rs
 *
 * The screen is rendered text: no escapes, each row right-trimmed, rows
 * joined by "\n" with a final "\n". A rule matches when every matcher on
 * it does: `contains` (each string, ignoring case), `regex` (each, on the
 * region), `line_regex` (each, on some line), `all`, `any` (one of) and
 * `not` (none of). The highest priority wins; on a tie, the earlier rule.
 */

export type ScreenState = "idle" | "working" | "blocked" | "unknown";

/** Matchers. A rule is a gate with a state, a priority and a region. */
export interface Gate {
  contains?: string[];
  regex?: string[];
  line_regex?: string[];
  all?: Gate[];
  any?: Gate[];
  not?: Gate[];
}

export interface Rule extends Gate {
  id: string;
  state?: ScreenState;
  priority?: number;
  region?: string;
  visible_idle?: boolean;
  visible_blocker?: boolean;
  visible_working?: boolean;
  /** A screen this rule matches (a transcript viewer) changes nothing. */
  skip_state_update?: boolean;
}

export interface RuleSet {
  id: string;
  version?: string;
  min_engine_version?: number;
  updated_at?: string;
  aliases?: string[];
  rules: Rule[];
}

/** What the engine reads: the screen, and the latest OSC title and progress. */
export interface Screen {
  text: string;
  /** The latest OSC 0/2 title ("" for none). */
  oscTitle?: string;
  /** The latest OSC 9 payload after "9;", such as "4;1;-1" ("" for none). */
  oscProgress?: string;
}

export interface Detection {
  state: ScreenState;
  /** The rule that decided it; null when none matched. */
  rule: string | null;
  /** No rule matched: idle by herdr's default; Den keeps today's signals. */
  fallback: boolean;
  /** A matched skip_state_update rule: leave the agent's state as it is. */
  skip: boolean;
  /** The screen shows a dialog that needs the person. */
  visibleBlocker: boolean;
}

/** The engine version this port carries (herdr's MANIFEST_ENGINE_VERSION). */
export const ENGINE_VERSION = 3;

const FIXED_REGIONS = new Set([
  "osc_title",
  "osc_progress",
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
]);
const COUNTED =
  /^(bottom_lines|bottom_non_empty_lines|top_non_empty_lines)\(([1-9]\d{0,4})\)$/;

/** Rust's str::lines(): split on "\n", no trailing empty line, "\r" dropped. */
function lines(text: string): string[] {
  if (!text) return [];
  const out = text.split("\n");
  if (out[out.length - 1] === "") out.pop();
  return out.map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
}

/** Where line `index` starts (each line counts its "\n"). */
function lineStart(text: string, ls: string[], index: number): number {
  let n = 0;
  for (let i = 0; i < Math.min(index, ls.length); i++) n += ls[i].length + 1;
  return Math.min(n, text.length);
}

const fromLine = (text: string, ls: string[], i: number) =>
  text.slice(lineStart(text, ls, i));

const promptLine = (l: string) => l === "›" || l.startsWith("› ");
const blockMarkerLine = (l: string) => /^[•■✗✓]/u.test(l);

/** The last prompt line with no block marker after it, if one. */
function currentPrompt(ls: string[]): number | undefined {
  let i = ls.length - 1;
  while (i >= 0 && !promptLine(ls[i])) i--;
  if (i < 0) return undefined;
  return ls.slice(i + 1).some(blockMarkerLine) ? undefined : i;
}

function isRule(line: string): boolean {
  const t = line.trim();
  if (!t) return false;
  let n = 0;
  for (const ch of t) {
    if (ch !== "─") break;
    n++;
  }
  if (!n) return false;
  return t.slice(n).trimStart() === "" || n >= 3;
}

/** The prompt box's top border: the second rule from the bottom. */
function boxTop(ls: string[]): number | undefined {
  let seen = 0;
  for (let i = ls.length - 1; i >= 0; i--)
    if (isRule(ls[i]) && ++seen === 2) return i;
  return undefined;
}

/** The text a rule's region names. */
export function region(screen: Screen, spec = "whole_recent"): string {
  const name = spec.trim();
  if (name === "osc_title") return screen.oscTitle ?? "";
  if (name === "osc_progress") return screen.oscProgress ?? "";
  const text = screen.text;
  const ls = lines(text);
  switch (name) {
    case "whole_recent":
      return text;
    case "after_last_prompt_marker": {
      let i = ls.length - 1;
      while (i >= 0 && !promptLine(ls[i])) i--;
      return i < 0 ? text : fromLine(text, ls, i + 1);
    }
    case "before_current_prompt_marker": {
      const i = currentPrompt(ls);
      return i === undefined ? text : text.slice(0, lineStart(text, ls, i));
    }
    case "whole_recent_without_current_prompt_marker":
      return currentPrompt(ls) === undefined ? text : "";
    case "current_prompt_block_marker":
    case "after_current_prompt_block_marker": {
      const p = currentPrompt(ls);
      if (p === undefined) return "";
      let b = p - 1;
      while (b >= 0 && !blockMarkerLine(ls[b])) b--;
      if (b < 0) return "";
      return name === "current_prompt_block_marker"
        ? ls[b]
        : fromLine(text, ls, b);
    }
    case "prompt_box_body": {
      const top = boxTop(ls);
      if (top === undefined) return "";
      let end = top + 1;
      while (end < ls.length && !isRule(ls[end])) end++;
      return text.slice(lineStart(text, ls, top + 1), lineStart(text, ls, end));
    }
    case "above_prompt_box":
    case "last_non_empty_above_prompt_box": {
      const top = boxTop(ls);
      const above =
        top === undefined ? text : text.slice(0, lineStart(text, ls, top));
      if (name === "above_prompt_box") return above;
      return (
        lines(above)
          .reverse()
          .find((l) => l.trim()) ?? ""
      );
    }
    case "after_last_horizontal_rule": {
      let end = 0;
      let at = 0;
      for (const l of ls) {
        at += l.length + 1;
        if (isRule(l)) end = Math.min(at, text.length);
      }
      return text.slice(end);
    }
  }
  const m = COUNTED.exec(name);
  if (!m) return "";
  const count = Number(m[2]);
  if (m[1] === "bottom_lines")
    return fromLine(text, ls, Math.max(0, ls.length - count));
  const filled = ls.flatMap((l, i) => (l.trim() ? [i] : []));
  if (!filled.length) return "";
  if (m[1] === "bottom_non_empty_lines")
    return fromLine(text, ls, filled[Math.max(0, filled.length - count)]);
  const last = filled[Math.min(count, filled.length) - 1];
  return text.slice(0, lineStart(text, ls, last + 1));
}

const compiled = new Map<string, RegExp>();

/**
 * A Rust regex as a JavaScript one: leading inline flags ((?i), (?m),
 * (?s)) become flags, \A and \z the text's very start and end, and
 * \x{…} a code point. Always Unicode. (JavaScript's \b and \d are ASCII,
 * Rust's Unicode: the vendored rules use them on ASCII words only.)
 */
export function toRegExp(pattern: string): RegExp {
  const hit = compiled.get(pattern);
  if (hit) return hit;
  let src = pattern;
  const flags = new Set(["u"]);
  for (
    let m = /^\(\?([ims]+)\)/.exec(src);
    m;
    m = /^\(\?([ims]+)\)/.exec(src)
  ) {
    for (const f of m[1]) flags.add(f);
    src = src.slice(m[0].length);
  }
  let out = "";
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c !== "\\") {
      out += c;
      continue;
    }
    const n = src[i + 1];
    if (n === "A") out += "(?<![\\s\\S])";
    else if (n === "z") out += "(?![\\s\\S])";
    else if (n === "x" && src[i + 2] === "{") {
      const close = src.indexOf("}", i + 3);
      out += `\\u{${src.slice(i + 3, close)}}`;
      i = close;
      continue;
    } else out += c + (n ?? "");
    i++;
  }
  const re = new RegExp(out, [...flags].join(""));
  compiled.set(pattern, re);
  return re;
}

function matches(g: Gate, text: string): boolean {
  if (g.contains?.length) {
    const low = text.toLowerCase();
    if (!g.contains.every((s) => low.includes(s.toLowerCase()))) return false;
  }
  if (g.regex?.length && !g.regex.every((p) => toRegExp(p).test(text)))
    return false;
  if (g.line_regex?.length) {
    const ls = lines(text);
    if (!g.line_regex.every((p) => ls.some((l) => toRegExp(p).test(l))))
      return false;
  }
  if (g.all?.length && !g.all.every((x) => matches(x, text))) return false;
  if (g.any?.length && !g.any.some((x) => matches(x, text))) return false;
  if (g.not?.length && g.not.some((x) => matches(x, text))) return false;
  return true;
}

/** A rule set's state for a screen. */
export function detect(set: RuleSet, screen: Screen): Detection {
  let best: Rule | undefined;
  for (const r of set.rules) {
    if (best && (best.priority ?? 0) >= (r.priority ?? 0)) continue;
    if (matches(r, region(screen, r.region))) best = r;
  }
  if (!best)
    return {
      state: "idle",
      rule: null,
      fallback: true,
      skip: false,
      visibleBlocker: false,
    };
  const state = best.state ?? "unknown";
  return {
    state,
    rule: best.id,
    fallback: false,
    skip: best.skip_state_update === true,
    visibleBlocker: best.visible_blocker === true && state === "blocked",
  };
}

const POSITIVE = ["contains", "regex", "line_regex", "all", "any"] as const;

function gateProblems(g: Gate, where: string, out: string[], top: boolean) {
  const has = (k: keyof Gate) => (g[k] as unknown[] | undefined)?.length;
  if (top ? !POSITIVE.some(has) : !POSITIVE.some(has) && !has("not"))
    out.push(`${where}: needs a matcher`);
  for (const k of ["regex", "line_regex"] as const)
    for (const p of g[k] ?? [])
      try {
        toRegExp(p);
      } catch (e) {
        out.push(`${where}.${k}: ${(e as Error).message}`);
      }
  for (const k of ["all", "any", "not"] as const)
    (g[k] ?? []).forEach((x, i) =>
      gateProblems(x, `${where}.${k}[${i}]`, out, false),
    );
}

/** What is wrong with a rule set ([] for nothing). */
export function ruleSetProblems(set: RuleSet): string[] {
  const out: string[] = [];
  if ((set.min_engine_version ?? 1) > ENGINE_VERSION)
    out.push(`${set.id}: needs engine ${set.min_engine_version}`);
  set.rules.forEach((r, i) => {
    const where = `${set.id}.rules[${i}] ${r.id}`;
    const reg = (r.region ?? "whole_recent").trim();
    if (!FIXED_REGIONS.has(reg) && !COUNTED.test(reg))
      out.push(`${where}: no region ${reg}`);
    if (r.skip_state_update && (r.state ?? "unknown") !== "unknown")
      out.push(`${where}: a skip rule's state is unknown`);
    gateProblems(r, where, out, true);
  });
  return out;
}
