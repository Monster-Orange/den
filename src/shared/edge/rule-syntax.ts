/**
 * Issue 519: Traefik v3 reads some v2 rule syntax differently: a named
 * group in HostRegexp or Path (`{sub:[a-z]+}`), several values in one
 * matcher, Headers/HeadersRegexp, HostHeader, Query(`k=v`). After the
 * upgrade those routes stop matching, with nothing that says why. So
 * before doctor suggests v3 it looks for them, in the routes Den renders,
 * the edge's included files, the stacks' route files and the Traefik
 * labels in the stacks' compose files.
 *
 * Read-only: files are parsed, never written, and docker is never called.
 * A file that can't be read or parsed is skipped.
 *
 * v2RuleSyntaxIn is the one check; anything that changes edge.image (the
 * held write of issue 395) can call it to add V2_COMPAT_ARG when it finds
 * v2 rules.
 */
import * as fs from "fs";
import * as path from "path";
import { parse } from "yaml";
import { includedRouters, stackRouters } from "./included.js";
import {
  DEFAULT_TRAEFIK_IMAGE,
  edgeImageCheck,
  hostRule,
  traefikMajor,
} from "./render.js";
import { getReposRoot, readUserConfig } from "../den-config.js";
import { readStacks } from "../stacks/config.js";
import { ruleSyntaxWord, type RuleSyntaxWord } from "./rule-syntax-words.js";
import type { EdgeConfig } from "./types.js";
import type { StackConfig } from "../stacks/types.js";
import { uiLanguage, type UiLanguage } from "../../ui/server/ui-language.js";

/** The flag that has Traefik v3 read every rule in v2 syntax. */
export const V2_COMPAT_ARG = "--core.defaultRuleSyntax=v2";

/** One router rule and where it is, as words for a person. */
export interface RuleAt {
  where: string;
  rule: string;
  /** The router's own `ruleSyntax`, when it sets one. */
  ruleSyntax?: string;
}

export type V2Why =
  | "namedGroup"
  | "multiArg"
  | "headers"
  | "hostHeader"
  | "queryEquals";

export interface V2Rule {
  where: string;
  rule: string;
  why: V2Why[];
}

/** Matchers whose argument v2 read as a pattern with `{name:regex}` groups. */
const NAMED_GROUP_MATCHERS = new Set(["HostRegexp", "Path", "PathPrefix"]);
/** Matchers v2 let take several values and v3 takes one. */
const ONE_VALUE_MATCHERS = new Set([
  "Host",
  "HostRegexp",
  "Path",
  "PathPrefix",
  "Method",
  "ClientIP",
  "HostSNI",
]);
const NAMED_GROUP = /\{[A-Za-z_][\w-]*(:[^}]*)?\}/;

/** Each matcher call in a rule, with its quoted arguments. */
function matchers(rule: string): { name: string; args: string[] }[] {
  const out: { name: string; args: string[] }[] = [];
  const re = /\b([A-Za-z]+)\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(rule))) {
    const args: string[] = [];
    let i = re.lastIndex;
    for (;;) {
      while (/\s/.test(rule[i] ?? "")) i++;
      const q = rule[i];
      if (q !== "`" && q !== '"' && q !== "'") break;
      const end = rule.indexOf(q, i + 1);
      if (end < 0) break;
      args.push(rule.slice(i + 1, end));
      i = end + 1;
      while (/\s/.test(rule[i] ?? "")) i++;
      if (rule[i] === ",") i++;
      else break;
    }
    out.push({ name: m[1], args });
    // Never look for matchers inside the arguments just read.
    re.lastIndex = Math.max(re.lastIndex, i);
  }
  return out;
}

/**
 * The rules that use Traefik v2-only syntax, each with why. A router that
 * sets `ruleSyntax: v2` keeps working on v3, so it is left out.
 */
export function v2RuleSyntaxIn(rules: readonly RuleAt[]): V2Rule[] {
  const out: V2Rule[] = [];
  for (const r of rules) {
    if (r.ruleSyntax?.trim().toLowerCase() === "v2") continue;
    const why = new Set<V2Why>();
    for (const { name, args } of matchers(r.rule)) {
      if (
        NAMED_GROUP_MATCHERS.has(name) &&
        args.some((a) => NAMED_GROUP.test(a))
      )
        why.add("namedGroup");
      if (ONE_VALUE_MATCHERS.has(name) && args.length > 1) why.add("multiArg");
      if (name === "Headers" || name === "HeadersRegexp") why.add("headers");
      if (name === "HostHeader") why.add("hostHeader");
      if (name === "Query" && args.length === 1 && args[0].includes("="))
        why.add("queryEquals");
    }
    if (why.size) out.push({ where: r.where, rule: r.rule, why: [...why] });
  }
  return out;
}

/** True when edge.args already has Traefik v3 read rules in v2 syntax. */
export function hasV2CompatArg(args: readonly string[]): boolean {
  return args.some((a, i) => {
    const x = a.trim().toLowerCase();
    if (x === V2_COMPAT_ARG.toLowerCase()) return true;
    return (
      x === "--core.defaultrulesyntax" &&
      args[i + 1]?.trim().toLowerCase() === "v2"
    );
  });
}

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};

/** A service's labels as key → value, from either compose form. */
function labelMap(v: unknown): Map<string, string> {
  const out = new Map<string, string>();
  if (Array.isArray(v)) {
    for (const x of v) {
      if (typeof x !== "string") continue;
      const eq = x.indexOf("=");
      if (eq > 0) out.set(x.slice(0, eq).trim(), x.slice(eq + 1));
    }
  } else
    for (const [k, x] of Object.entries(obj(v)))
      if (typeof x === "string") out.set(k, x);
  return out;
}

const ROUTER_RULE = /^traefik\.(http|tcp)\.routers\.([^.]+)\.rule$/i;

/** The router rules in one compose document's Traefik labels. */
export function labelRules(doc: unknown, file: string): RuleAt[] {
  const out: RuleAt[] = [];
  for (const [svc, def] of Object.entries(obj(obj(doc).services))) {
    const labels = labelMap(obj(def).labels);
    for (const [key, rule] of labels) {
      const m = ROUTER_RULE.exec(key);
      if (!m) continue;
      const base = key.slice(0, -".rule".length).toLowerCase();
      const syntax = [...labels].find(
        ([k]) => k.toLowerCase() === `${base}.rulesyntax`,
      )?.[1];
      out.push({
        where: `${file} service ${svc} label ${key}`,
        rule,
        ...(syntax ? { ruleSyntax: syntax } : {}),
      });
    }
  }
  return out;
}

export interface EdgeRulesDeps {
  /** The stacks whose compose files to read (default: readStacks). */
  stacks?: () => StackConfig[];
}

/** The configured stacks, or none when the config can't be read. */
function defaultStacks(): StackConfig[] {
  try {
    return Object.values(readStacks());
  } catch {
    try {
      return Object.values(readStacks(undefined, { manifests: false }));
    } catch {
      return [];
    }
  }
}

/** A stack's compose files, each as the path a person would name it by. */
function composeRules(s: StackConfig, reposRoot: () => string): RuleAt[] {
  const out: RuleAt[] = [];
  let dir: string;
  try {
    dir = path.join(s.repoPath ?? path.join(reposRoot(), s.repo), s.dir ?? "");
  } catch {
    return out;
  }
  for (const f of s.files ?? []) {
    try {
      const doc: unknown = parse(fs.readFileSync(path.join(dir, f), "utf-8"));
      out.push(...labelRules(doc, path.join(s.repo, s.dir ?? "", f)));
    } catch {
      // Not there or not YAML: nothing to read.
    }
  }
  return out;
}

/**
 * Every router rule the edge can serve that Den can read from files: its
 * own routes, the included files, the stacks' route files, and the
 * Traefik labels in the stacks' compose files.
 */
export function edgeRules(cfg: EdgeConfig, deps: EdgeRulesDeps = {}): RuleAt[] {
  const out: RuleAt[] = [];
  for (const name of Object.keys(cfg.routes ?? {}).sort())
    out.push({ where: `edge route ${name}`, rule: hostRule(name, cfg) });
  for (const read of [includedRouters, stackRouters]) {
    let routers: ReturnType<typeof includedRouters>["routers"] = [];
    try {
      routers = read(cfg).routers;
    } catch {
      routers = [];
    }
    for (const r of routers)
      out.push({
        where: `${r.file} router ${r.name}`,
        rule: r.rule,
        ...(r.ruleSyntax ? { ruleSyntax: r.ruleSyntax } : {}),
      });
  }
  for (const s of (deps.stacks ?? defaultStacks)())
    out.push(...composeRules(s, getReposRoot));
  return out;
}

/** The v2-only rules the edge has (for issue 395's image change, too). */
export function edgeV2Rules(
  cfg: EdgeConfig,
  deps: EdgeRulesDeps = {},
): V2Rule[] {
  return v2RuleSyntaxIn(edgeRules(cfg, deps));
}

/** The person's language (user.yml `language`), English when unset. */
function personLanguage(): UiLanguage {
  try {
    return uiLanguage(readUserConfig().language);
  } catch {
    return "en";
  }
}

/**
 * Doctor's edge.image lines: edgeImageCheck's, unless the image is older
 * than v3 (or unknown) and v2-only rules exist; then the rules, where they
 * are, and the two ways to move: the compat flag, or rewriting them.
 */
export function edgeImageHint(
  cfg: Pick<EdgeConfig, "image" | "args">,
  v2: readonly V2Rule[],
  lang: UiLanguage = personLanguage(),
): { status: "ok" | "warn"; detail: string; lines: string[] } {
  const base = edgeImageCheck(cfg);
  if (base.status === "ok" || !v2.length)
    return { ...base, lines: [base.detail] };
  const w = (k: RuleSyntaxWord, vars: Record<string, string | number> = {}) =>
    ruleSyntaxWord(lang, k, {
      image: cfg.image,
      target: DEFAULT_TRAEFIK_IMAGE,
      arg: V2_COMPAT_ARG,
      ...vars,
    });
  if (hasV2CompatArg(cfg.args ?? [])) {
    const lines = [base.detail, w("compatSet")];
    return { status: "warn", detail: lines.join(" "), lines };
  }
  const major = traefikMajor(cfg.image);
  const lines = [
    major === null
      ? w("headUnknown", { count: v2.length })
      : w("head", { major, count: v2.length }),
    ...v2.map(
      (r) =>
        "  " +
        w("rule", {
          where: r.where,
          rule: r.rule,
          why: r.why.map((y) => w(`why.${y}` as RuleSyntaxWord)).join("; "),
        }),
    ),
    w("compat"),
    w("rewrite"),
  ];
  return { status: "warn", detail: lines.join(" "), lines };
}
