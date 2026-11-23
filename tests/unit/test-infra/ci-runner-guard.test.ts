/**
 * CI runs on a self-hosted runner only when the DEN_SELF_HOSTED variable is
 * on and the code came from this repo (a push, or a pull request whose head
 * branch lives here). A fork's pull request always runs on a GitHub-hosted
 * runner, so code from outside never reaches the box. pull_request_target
 * (which runs a fork's PR with this repo's secrets) is never used.
 *
 * Issue 398: in the day only two ci.yml jobs may go to the box, the Node 22
 * legs of the fast checks and of the install smoke: two jobs a run, for its
 * two day runners. Every other job is always GitHub-hosted. The repeat
 * workflow (repeat.yml, run by hand) uses its own variable,
 * DEN_SELF_HOSTED_NIGHT, so night runs never depend on the day switch.
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

// Issue 1226: the runner's labels come from DEN_SELF_HOSTED_LABELS (a JSON
// array, such as ["self-hosted","devbox"]); unset, today's label.
const LABELS =
  'fromJSON(vars.DEN_SELF_HOSTED_LABELS || \'["self-hosted","den-wsl"]\')';

const GUARD =
  "${{ (vars.DEN_SELF_HOSTED == 'on' && matrix.node == '22.13.0' && " +
  "(github.event_name == 'push' || " +
  "github.event.pull_request.head.repo.full_name == github.repository)) && " +
  LABELS +
  " || 'ubuntu-latest' }}";

// The jobs that may use the box in the day (their Node 22 leg only).
const BOX_JOBS = ["checks", "dist-smoke"];

// Issue 1226: the pull-request jobs, any Node, for a merge-queue run or a
// pull request whose head branch lives here; a fork's stays hosted.
const PR_GUARD =
  "${{ (vars.DEN_SELF_HOSTED == 'on' && " +
  "(github.event_name == 'merge_group' || " +
  "github.event.pull_request.head.repo.full_name == github.repository)) && " +
  LABELS +
  " || 'ubuntu-latest' }}";
// den-ui-nav stays hosted: its browser image is pinned to linux/amd64.
const PR_BOX_JOBS = ["pr", "pr-shards"];
const guardOf = (job: string) =>
  BOX_JOBS.includes(job)
    ? GUARD
    : PR_BOX_JOBS.includes(job)
      ? PR_GUARD
      : "ubuntu-latest";

const NIGHT_GUARD =
  "${{ vars.DEN_SELF_HOSTED_NIGHT == 'on' && " +
  "fromJSON('[\"self-hosted\",\"den-wsl\"]') || 'ubuntu-latest' }}";

const SELF_HOSTED = ["self-hosted", "den-wsl"];
const REPO = "owner/den";

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

function prEvent(headRepo: string): Record<string, unknown> {
  return {
    event_name: "pull_request",
    repository: REPO,
    event: { pull_request: { head: { repo: { full_name: headRepo } } } },
  };
}

const PUSH = { event_name: "push", repository: REPO, event: {} };

// --- the tests -------------------------------------------------------------

describe("CI's self-hosted runner guard", () => {
  it("only the checks, the install smoke, pr and pr-shards may use the box; every other ci.yml job is GitHub-hosted", () => {
    const jobs = workflow("ci.yml").jobs;
    expect(Object.keys(jobs).length).toBeGreaterThan(2);
    for (const [name, job] of Object.entries(jobs)) {
      expect({ job: name, "runs-on": job["runs-on"] }).toEqual({
        job: name,
        "runs-on": guardOf(name),
      });
    }
  });

  it("DEN_SELF_HOSTED appears in no other job, and in no other workflow", () => {
    const jobs = workflow("ci.yml").jobs;
    for (const [name, job] of Object.entries(jobs)) {
      if (guardOf(name) !== "ubuntu-latest") continue;
      expect({
        job: name,
        uses: /DEN_SELF_HOSTED/.test(JSON.stringify(job)),
      }).toEqual({ job: name, uses: false });
    }
    for (const file of fs.readdirSync(WORKFLOWS)) {
      if (file === "ci.yml" || !/\.ya?ml$/.test(file)) continue;
      expect({ file, uses: /DEN_SELF_HOSTED\b/.test(text(file)) }).toEqual({
        file,
        uses: false,
      });
    }
  });

  it("only the Node 22 leg goes to the box", () => {
    const push = (node: string) => ({
      vars: { DEN_SELF_HOSTED: "on" },
      matrix: { node },
      github: PUSH,
    });
    expect(evaluate(GUARD, push("22.13.0"))).toEqual(SELF_HOSTED);
    expect(evaluate(GUARD, push("24.13.0"))).toBe("ubuntu-latest");
  });

  it("the label variable picks the runner; unset, today's label", () => {
    const push = (labels?: string) => ({
      vars: {
        DEN_SELF_HOSTED: "on",
        ...(labels ? { DEN_SELF_HOSTED_LABELS: labels } : {}),
      },
      matrix: { node: "22.13.0" },
      github: PUSH,
    });
    expect(evaluate(GUARD, push())).toEqual(SELF_HOSTED);
    expect(evaluate(GUARD, push('["self-hosted","devbox"]'))).toEqual([
      "self-hosted",
      "devbox",
    ]);
  });

  it("pull-request jobs: a same-repo PR or the merge queue goes to the box, any Node; a fork's never", () => {
    const on = {
      DEN_SELF_HOSTED: "on",
      DEN_SELF_HOSTED_LABELS: '["self-hosted","devbox"]',
    };
    const box = ["self-hosted", "devbox"];
    for (const node of ["24.13.0", "22.13.0"]) {
      expect(
        evaluate(PR_GUARD, {
          vars: on,
          matrix: { node },
          github: prEvent(REPO),
        }),
      ).toEqual(box);
      expect(
        evaluate(PR_GUARD, {
          vars: on,
          matrix: { node },
          github: { event_name: "merge_group", repository: REPO, event: {} },
        }),
      ).toEqual(box);
      expect(
        evaluate(PR_GUARD, {
          vars: on,
          matrix: { node },
          github: prEvent("someone/den"),
        }),
      ).toBe("ubuntu-latest");
    }
    // The switch off: hosted, whatever the labels say.
    expect(
      evaluate(PR_GUARD, {
        vars: { DEN_SELF_HOSTED_LABELS: '["self-hosted","devbox"]' },
        github: prEvent(REPO),
      }),
    ).toBe("ubuntu-latest");
    // A run by hand (workflow_dispatch) stays hosted.
    expect(
      evaluate(PR_GUARD, {
        vars: on,
        github: {
          event_name: "workflow_dispatch",
          repository: REPO,
          event: {},
        },
      }),
    ).toBe("ubuntu-latest");
  });

  it("the release's workflows never name a self-hosted variable", () => {
    for (const f of ["release.yml", "release-gates.yml", "release-dry-run.yml"])
      expect([f, /DEN_SELF_HOSTED|self-hosted/.test(text(f))]).toEqual([
        f,
        false,
      ]);
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

  it("a fork's pull request with the variable on runs GitHub-hosted", () => {
    const ctx = {
      vars: { DEN_SELF_HOSTED: "on" },
      matrix: { node: "22.13.0" },
      github: prEvent("fork/den"),
    };
    expect(evaluate(GUARD, ctx)).toBe("ubuntu-latest");
  });

  it("a fork's pull request with the variable off runs GitHub-hosted", () => {
    const ctx = {
      vars: { DEN_SELF_HOSTED: "off" },
      github: prEvent("fork/den"),
    };
    expect(evaluate(GUARD, ctx)).toBe("ubuntu-latest");
  });

  it("a same-repo pull request with the variable on runs self-hosted", () => {
    const ctx = {
      vars: { DEN_SELF_HOSTED: "on" },
      matrix: { node: "22.13.0" },
      github: prEvent(REPO),
    };
    expect(evaluate(GUARD, ctx)).toEqual(SELF_HOSTED);
  });

  it("a push with the variable on runs self-hosted", () => {
    const ctx = {
      vars: { DEN_SELF_HOSTED: "on" },
      matrix: { node: "22.13.0" },
      github: PUSH,
    };
    expect(evaluate(GUARD, ctx)).toEqual(SELF_HOSTED);
  });

  it("a push with the variable unset runs GitHub-hosted", () => {
    expect(evaluate(GUARD, { vars: {}, github: PUSH })).toBe("ubuntu-latest");
    expect(evaluate(GUARD, { github: PUSH })).toBe("ubuntu-latest");
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
