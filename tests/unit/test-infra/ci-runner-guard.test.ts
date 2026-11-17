/**
 * The self-hosted runners are for night runs only (issue 398). Every ci.yml
 * job runs GitHub-hosted, and no workflow names the day switch
 * (DEN_SELF_HOSTED). The repeat workflow (repeat.yml, run by hand, which
 * needs write access, so never from a fork) runs self-hosted only when
 * DEN_SELF_HOSTED_NIGHT is on. pull_request_target (which runs a fork's PR
 * with this repo's secrets) is never used.
 *
 * The runs-on expression is evaluated by a small parser written for exactly
 * its shape: string literals, context paths, fromJSON, ==, && and ||.
 * GitHub's && and || return an operand's value (not a boolean), the same as
 * JavaScript's for these operands, and a missing context property is null.
 */
import { describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import * as yaml from "yaml";

const ROOT = process.cwd();
const WORKFLOWS = path.join(ROOT, ".github", "workflows");

const NIGHT_GUARD =
  "${{ vars.DEN_SELF_HOSTED_NIGHT == 'on' && " +
  "fromJSON('[\"self-hosted\",\"den-wsl\"]') || 'ubuntu-latest' }}";

const SELF_HOSTED = ["self-hosted", "den-wsl"];

interface Workflow {
  on?: unknown;
  permissions?: unknown;
  jobs: Record<string, { "runs-on"?: unknown; permissions?: unknown }>;
}

function text(file: string): string {
  return fs.readFileSync(path.join(WORKFLOWS, file), "utf-8");
}

function workflow(file: string): Workflow {
  return yaml.parse(
    fs.readFileSync(path.join(WORKFLOWS, file), "utf-8"),
  ) as Workflow;
}

// --- the evaluator ---------------------------------------------------------

type Value = string | boolean | null | unknown[] | Record<string, unknown>;

function tokenize(src: string): string[] {
  const out: string[] = [];
  const re = /\s*('(?:[^']|'')*'|&&|\|\||==|[(),]|[A-Za-z_][\w.-]*)/y;
  let i = 0;
  while (i < src.length) {
    if (/^\s*$/.test(src.slice(i))) break;
    re.lastIndex = i;
    const m = re.exec(src);
    if (!m) throw new Error(`unexpected input at ${i}: ${src.slice(i)}`);
    out.push(m[1]);
    i = re.lastIndex;
  }
  return out;
}

function lookup(ctx: Record<string, unknown>, ref: string): Value {
  let cur: unknown = ctx;
  for (const key of ref.split(".")) {
    if (cur === null || typeof cur !== "object") return null;
    cur = (cur as Record<string, unknown>)[key];
  }
  return (cur ?? null) as Value;
}

// GitHub compares strings case-insensitively; other operands must match.
function equal(a: Value, b: Value): boolean {
  if (typeof a === "string" && typeof b === "string") {
    return a.toLowerCase() === b.toLowerCase();
  }
  return a === b;
}

function truthy(v: Value): boolean {
  return v !== null && v !== false && v !== "";
}

function evaluate(expr: string, ctx: Record<string, unknown>): Value {
  const m = /^\$\{\{(.*)\}\}$/s.exec(expr.trim());
  if (!m) throw new Error(`not an expression: ${expr}`);
  const toks = tokenize(m[1]);
  let p = 0;
  const peek = (): string | undefined => toks[p];
  const take = (want?: string): string => {
    const t = toks[p++];
    if (t === undefined || (want !== undefined && t !== want)) {
      throw new Error(`expected ${want ?? "a token"}, got ${t}`);
    }
    return t;
  };

  const primary = (): Value => {
    const t = take();
    if (t === "(") {
      const v = or();
      take(")");
      return v;
    }
    if (t.startsWith("'")) return t.slice(1, -1).replace(/''/g, "'");
    if (t === "fromJSON") {
      take("(");
      const arg = or();
      take(")");
      if (typeof arg !== "string") throw new Error("fromJSON needs a string");
      return JSON.parse(arg) as Value;
    }
    if (/^(vars|github|matrix)\./.test(t)) return lookup(ctx, t);
    throw new Error(`unsupported token: ${t}`);
  };
  const eq = (): Value => {
    const left = primary();
    if (peek() !== "==") return left;
    take("==");
    return equal(left, primary());
  };
  const and = (): Value => {
    let v = eq();
    while (peek() === "&&") {
      take("&&");
      const r = eq();
      v = truthy(v) ? r : v;
    }
    return v;
  };
  const or = (): Value => {
    let v = and();
    while (peek() === "||") {
      take("||");
      const r = and();
      v = truthy(v) ? v : r;
    }
    return v;
  };

  const v = or();
  if (p !== toks.length) throw new Error(`trailing tokens: ${toks.slice(p)}`);
  return v;
}

// --- the tests -------------------------------------------------------------

describe("CI's self-hosted runner guard", () => {
  it("every ci.yml job runs GitHub-hosted", () => {
    const jobs = workflow("ci.yml").jobs;
    expect(Object.keys(jobs).length).toBeGreaterThan(0);
    for (const [name, job] of Object.entries(jobs)) {
      expect({ job: name, "runs-on": job["runs-on"] }).toEqual({
        job: name,
        "runs-on": "ubuntu-latest",
      });
    }
  });

  it("no workflow names the day switch DEN_SELF_HOSTED", () => {
    const files = fs.readdirSync(WORKFLOWS).filter((f) => /\.ya?ml$/.test(f));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect({ file, uses: /DEN_SELF_HOSTED\b/.test(text(file)) }).toEqual({
        file,
        uses: false,
      });
    }
  });

  it("release.yml never names a self-hosted variable", () => {
    expect(text("release.yml")).not.toMatch(/DEN_SELF_HOSTED|self-hosted/);
  });

  it("repeat.yml: run by hand only, read-only, on its own night variable", () => {
    const w = workflow("repeat.yml");
    const on = w.on as Record<string, unknown>;
    expect(Object.keys(on)).toEqual(["workflow_dispatch"]);
    expect(w.permissions).toEqual({ contents: "read" });
    const jobs = Object.values(w.jobs);
    expect(jobs.length).toBeGreaterThan(0);
    for (const job of jobs) {
      expect(job["runs-on"]).toBe(NIGHT_GUARD);
      expect(job.permissions).toBeUndefined();
    }
    expect(
      evaluate(NIGHT_GUARD, { vars: { DEN_SELF_HOSTED_NIGHT: "on" } }),
    ).toEqual(SELF_HOSTED);
    expect(evaluate(NIGHT_GUARD, { vars: { DEN_SELF_HOSTED: "on" } })).toBe(
      "ubuntu-latest",
    );
    expect(evaluate(NIGHT_GUARD, { vars: {} })).toBe("ubuntu-latest");
  });

  it("no workflow is triggered by pull_request_target", () => {
    const files = fs.readdirSync(WORKFLOWS).filter((f) => /\.ya?ml$/.test(f));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const on = workflow(file).on;
      expect(on).toBeDefined();
      const triggers =
        typeof on === "string"
          ? [on]
          : Array.isArray(on)
            ? (on as string[])
            : Object.keys(on as object);
      expect({ file, triggers }).toEqual({
        file,
        triggers: triggers.filter((t) => t !== "pull_request_target"),
      });
    }
  });
});
