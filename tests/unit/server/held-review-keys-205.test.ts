/**
 * Issue 205: every held write's Review lines are shown in the page's
 * language. Each check that returns Review lines (`details`) returns a
 * message key for every line (`detailKeys`), and each key is in the en,
 * es and ja catalogs with the same {vars}.
 *
 * Found by reading the source: a held check's answer is the object with a
 * `summary:` and then `details:`. A new held write is covered without
 * being listed here. The held writes in held-actions.ts are also run, with
 * stand-in deps, to check one key per line.
 */
import { describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import * as vm from "vm";
import ts from "typescript";
import {
  heldActions,
  type HeldActionDeps,
} from "../../../src/ui/server/held-actions.js";

const SRC = path.join(process.cwd(), "src");
const PUBLIC = path.join(SRC, "ui", "server", "public");

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === "public" ? [] : walk(p);
    return /\.ts$/.test(e.name) && !/\.d\.ts$/.test(e.name) ? [p] : [];
  });
}

/** Each held check's answer: file, line, and its text from `summary:` on. */
function answers(): { at: string; text: string }[] {
  const out: { at: string; text: string }[] = [];
  for (const f of walk(SRC)) {
    const src = fs.readFileSync(f, "utf-8");
    const lines = src.split("\n");
    lines.forEach((l, i) => {
      // `...review([...])` and `...reviewLines([...])` return both lists
      // from one list of [line, key] pairs, so they count as keyed.
      const spread = /^\s+\.\.\.(review|reviewLines)\(/.test(l);
      if (!spread && !/^\s+details: (\[|lines\.map|\w+\.map)/.test(l)) return;
      const before = lines.slice(Math.max(0, i - 12), i).join("\n");
      if (!/\bsummary:/.test(before)) return;
      if (spread) {
        out.push({
          at: `${path.relative(process.cwd(), f)}:${i + 1}`,
          text: "detailKeys: (from its pairs)",
        });
        return;
      }
      // The answer's rest: up to where its object closes (the indent of
      // `details:` minus one level).
      const indent = /^\s*/.exec(l)![0].length;
      let end = i + 1;
      while (
        end < lines.length &&
        !(
          lines[end].trim() &&
          /^\s*/.exec(lines[end])![0].length < indent &&
          /^\s*[}\]]/.test(lines[end])
        )
      )
        end++;
      out.push({
        at: `${path.relative(process.cwd(), f)}:${i + 1}`,
        text: lines.slice(i, end).join("\n"),
      });
    });
  }
  return out;
}

/** The catalogs: en from shell.js, es and ja from i18n/. */
function catalogs(): Record<string, Record<string, string>> {
  const window: Record<string, unknown> = {};
  const document = {
    getElementById: () => null,
    documentElement: { lang: "en" },
    addEventListener: () => {},
  };
  const ctx = vm.createContext({ window, document, Intl });
  for (const f of ["i18n/es.js", "i18n/ja.js", "shell.js"]) {
    try {
      vm.runInContext(fs.readFileSync(path.join(PUBLIC, f), "utf-8"), ctx);
    } catch {
      /* shell.js stops at its first DOM use; its catalog is set first */
    }
  }
  return window.denMessages as Record<string, Record<string, string>>;
}

const vars = (s: string) =>
  [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe("issue 205: every held write's Review lines have keys", () => {
  const found = answers();

  it("finds the held checks (a sanity floor)", () => {
    expect(found.length).toBeGreaterThan(25);
  });

  it("every held check that returns Review lines returns their keys", () => {
    const missing = found
      .filter((a) => !/\bdetailKeys:/.test(a.text))
      .map((a) => a.at);
    expect(missing).toEqual([]);
  });

  it("every Review key is in en, es and ja, with the same {vars}", () => {
    const m = catalogs();
    const keys = new Set<string>();
    for (const f of walk(SRC))
      for (const k of fs
        .readFileSync(f, "utf-8")
        .matchAll(/key: "(ap\.[a-zA-Z0-9_.]+)"/g))
        keys.add(k[1]);
    expect(keys.size).toBeGreaterThan(20);
    const wrong: string[] = [];
    for (const k of keys)
      for (const l of ["en", "es", "ja"]) {
        const s = m[l]?.[k];
        if (typeof s !== "string") wrong.push(`${l} lacks ${k}`);
        else if (vars(s).join() !== vars(m.en[k] ?? "").join())
          wrong.push(`${l} ${k}: {${vars(s)}} vs en {${vars(m.en[k] ?? "")}}`);
      }
    expect(wrong).toEqual([]);
  });
});

/** Stand-in deps: each held write in held-actions.ts can answer its check. */
function deps(): HeldActionDeps {
  return {
    rules: () => ({ home: "/home/x" }) as never,
    validate: () => ({ ok: true }) as never,
    workspaceCreateRefusal: () => null,
    createWorkspace: (n: string) => n,
    activateWorkspace: () => {},
    workspaceActive: (n: string) => n === "default",
    workspaceExists: () => true,
    defaultWorkspace: () => "default",
    serviceTarget: (s: string) => ({ ok: true, address: s }),
    tryService: async () => ({}) as never,
    restartDen: async () => ({ ok: true }),
    updateDen: async () => ({ ok: true }),
    agentImport: async () => ({}) as never,
    prClose: async () => ({}) as never,
    approvalPolicy: {
      read: () => undefined,
      write: () => {},
    },
  } as unknown as HeldActionDeps;
}

describe("issue 205: held-actions.ts's checks, run: one key per line", () => {
  const acts = heldActions(deps()) as unknown as Record<
    string,
    { check: (a: Record<string, unknown>, who?: unknown) => unknown }
  >;
  it.each([
    ["workspace_create", { name: "north" }],
    ["service_try", { service: "api.north", workspace: "north" }],
    ["den_restart", { reason: "a new setting" }],
    ["den_update", { version: "0.4.90", reason: "a fix" }],
    [
      "agent_import",
      {
        project: "north",
        session: "0b6f1c2e-6a4f-4a9e-9a55-6d3a3f0e2b11",
        persona: "builder",
      },
    ],
    ["pr_close", { repo: "acme/api", pr: 12, comment: "superseded by 14" }],
  ] as const)("%s", async (name, args) => {
    const act = acts[name];
    expect(act).toBeDefined();
    const c = (await act.check({ ...args }, {})) as {
      ok: boolean;
      error?: string;
      details?: string[];
      detailKeys?: ({ key: string } | null)[];
    };
    expect(c.error ?? null).toBeNull();
    expect(c.details?.length).toBeGreaterThan(0);
    expect(c.detailKeys?.length).toBe(c.details!.length);
    expect(c.detailKeys!.every((k) => k && k.key)).toBe(true);
  });
});

/**
 * Issue 205 (review): the Allow dialog says exactly what Den does, in
 * every language, so each Review line's key, rendered in English, is that
 * line word for word. Read from the source with TypeScript's parser:
 *
 *   - every key sits beside its line: `[text, { key, vars }]`, or
 *     `line(text, key, vars)` / `rl(…)` (never a separate list of keys);
 *   - the line's text with each `${expr}` put back as the `{var}` its
 *     vars give that expr is the en catalog's string for the key.
 */
type Pair = { at: string; text: string | null; key: string; why?: string };

function reviewPairs(): { pairs: Pair[]; unpaired: string[] } {
  const pairs: Pair[] = [];
  const unpaired: string[] = [];
  for (const f of walk(SRC)) {
    const src = fs.readFileSync(f, "utf-8");
    if (!src.includes('"ap.')) continue;
    const sf = ts.createSourceFile(f, src, ts.ScriptTarget.Latest, true);
    const at = (n: ts.Node) =>
      `${path.relative(process.cwd(), f)}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1}`;
    const consts = new Map<string, ts.Expression>();
    const keyOf = (o: ts.Node): string | null => {
      if (!ts.isObjectLiteralExpression(o)) return null;
      for (const p of o.properties)
        if (
          ts.isPropertyAssignment(p) &&
          p.name.getText(sf) === "key" &&
          ts.isStringLiteral(p.initializer) &&
          p.initializer.text.startsWith("ap.")
        )
          return p.initializer.text;
      return null;
    };
    /** An expression as it renders: String(x), String(x ?? ""), x! are x. */
    const norm = (x: string): string => {
      let t = x.trim();
      for (;;) {
        const m = /^String\(([\s\S]*)\)$/.exec(t);
        const n = /^([\s\S]*?)\s*\?\?\s*""$/.exec(t);
        if (m) t = m[1].trim();
        else if (n) t = n[1].trim();
        else if (t.endsWith("!")) t = t.slice(0, -1).trim();
        else return t;
      }
    };
    /** var name → the expression's source text. */
    const varsOf = (
      o: ts.Expression | undefined,
    ): Map<string, string> | null => {
      const m = new Map<string, string>();
      if (!o) return m;
      if (!ts.isObjectLiteralExpression(o)) return null;
      for (const p of o.properties) {
        if (ts.isShorthandPropertyAssignment(p))
          m.set(p.name.text, p.name.text);
        else if (ts.isPropertyAssignment(p))
          m.set(p.name.getText(sf), norm(p.initializer.getText(sf)));
        else return null;
      }
      return m;
    };
    const textOf = (
      e: ts.Expression,
      vars: Map<string, string>,
    ): { text: string | null; why?: string } => {
      if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e))
        return { text: e.text };
      if (ts.isIdentifier(e) && consts.has(e.text))
        return textOf(consts.get(e.text)!, vars);
      // A line that is one var, whole (a persona's own words).
      const whole = [...vars].find(([, v]) => v === norm(e.getText(sf)));
      if (whole) return { text: `{${whole[0]}}` };
      if (ts.isTemplateExpression(e)) {
        let out = e.head.text;
        for (const s of e.templateSpans) {
          const x = norm(s.expression.getText(sf));
          const name = [...vars].find(([, v]) => v === x)?.[0];
          if (!name) return { text: null, why: `\${${x}} is in no var` };
          out += `{${name}}${s.literal.text}`;
        }
        return { text: out };
      }
      return { text: null, why: `its text is ${ts.SyntaxKind[e.kind]}` };
    };
    const pairAt = (n: ts.Node, textE: ts.Expression, keyE: ts.Node) => {
      const key =
        keyOf(keyE) ??
        (ts.isStringLiteral(keyE) && keyE.text.startsWith("ap.")
          ? keyE.text
          : null);
      if (!key) return false;
      const vars = ts.isObjectLiteralExpression(keyE)
        ? varsOf(
            keyE.properties
              .filter(ts.isPropertyAssignment)
              .find((p) => p.name.getText(sf) === "vars")?.initializer,
          )
        : null;
      if (!vars) {
        pairs.push({
          at: at(n),
          text: null,
          key,
          why: "its vars aren't an object",
        });
        return true;
      }
      const t = textOf(textE, vars);
      pairs.push({ at: at(n), key, ...t });
      return true;
    };
    const paired = new Set<ts.Node>();
    const visit = (n: ts.Node): void => {
      if (
        ts.isVariableDeclaration(n) &&
        ts.isIdentifier(n.name) &&
        n.initializer &&
        (ts.isStringLiteral(n.initializer) ||
          ts.isNoSubstitutionTemplateLiteral(n.initializer))
      )
        consts.set(n.name.text, n.initializer);
      if (ts.isArrayLiteralExpression(n) && n.elements.length === 2) {
        const [a, b] = n.elements;
        if (!keyOf(a) && keyOf(b) && pairAt(n, a, b)) paired.add(b);
      }
      if (
        ts.isCallExpression(n) &&
        ts.isIdentifier(n.expression) &&
        ["line", "rl"].includes(n.expression.text) &&
        n.arguments.length >= 2 &&
        ts.isStringLiteral(n.arguments[1])
      ) {
        const vars = varsOf(n.arguments[2]);
        const key = n.arguments[1].text;
        if (!vars)
          pairs.push({
            at: at(n),
            text: null,
            key,
            why: "its vars aren't an object",
          });
        else pairs.push({ at: at(n), key, ...textOf(n.arguments[0], vars) });
      }
      if (keyOf(n) && !paired.has(n)) unpaired.push(`${at(n)} ${keyOf(n)}`);
      ts.forEachChild(n, visit);
    };
    // Constants first (a line may use one defined below it).
    const collect = (n: ts.Node): void => {
      if (
        ts.isVariableDeclaration(n) &&
        ts.isIdentifier(n.name) &&
        n.initializer &&
        (ts.isStringLiteral(n.initializer) ||
          ts.isNoSubstitutionTemplateLiteral(n.initializer) ||
          ts.isTemplateExpression(n.initializer))
      )
        consts.set(n.name.text, n.initializer);
      ts.forEachChild(n, collect);
    };
    collect(sf);
    // Pairs first, so a key inside one isn't counted as unpaired.
    const pairsFirst = (n: ts.Node): void => {
      if (ts.isArrayLiteralExpression(n) && n.elements.length === 2) {
        const [a, b] = n.elements;
        if (!keyOf(a) && keyOf(b)) paired.add(b);
      }
      ts.forEachChild(n, pairsFirst);
    };
    pairsFirst(sf);
    visit(sf);
  }
  return { pairs, unpaired };
}

describe("issue 205: each Review key says its line, word for word", () => {
  const { pairs, unpaired } = reviewPairs();

  it("finds the lines (a sanity floor)", () => {
    expect(pairs.length).toBeGreaterThan(60);
  });

  it("every key sits beside its line, never in a separate list", () => {
    expect(unpaired).toEqual([]);
  });

  it("each key, in English, is its line exactly", () => {
    const en = catalogs().en;
    const wrong = pairs
      .filter((p) => p.text === null || en[p.key] !== p.text)
      .map((p) =>
        p.text === null
          ? `${p.at} ${p.key}: ${p.why}`
          : `${p.at} ${p.key}:\n  line: ${p.text}\n  en:   ${en[p.key] ?? "(none)"}`,
      );
    expect(wrong).toEqual([]);
  });
});
