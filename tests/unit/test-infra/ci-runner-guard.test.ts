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
 * its shape: string literals, context paths, fromJSON, startsWith, contains,
 * ==, !=, && and ||.
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

// Issue 1226: the pull-request jobs, any Node, for a pull request whose
// head branch lives here. A fork's, a merge-queue run and a run by hand stay
// GitHub-hosted.
const PR_GUARD =
  "${{ (vars.DEN_SELF_HOSTED == 'on' && " +
  "github.event.pull_request.head.repo.full_name == github.repository) && " +
  LABELS +
  " || 'ubuntu-latest' }}";
const PR_BOX_JOBS = ["pr", "pr-shards"];
const guardOf = (job: string) =>
  BOX_JOBS.includes(job)
    ? GUARD
    : PR_BOX_JOBS.includes(job)
      ? PR_GUARD
      : "ubuntu-latest";

const NIGHT_GUARD =
  "${{ (github.event_name == 'workflow_dispatch' && " +
  "vars.DEN_SELF_HOSTED_NIGHT == 'on') && " +
  "fromJSON('[\"self-hosted\",\"den-wsl\"]') || 'ubuntu-latest' }}";

const SELF_HOSTED = ["self-hosted", "den-wsl"];
const REPO = "owner/den";
const BY_HAND = {
  event_name: "workflow_dispatch",
  repository: REPO,
  event: {},
};

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
const BAD: Value = Object.freeze({ bad: "fromJSON" });

function tokenize(src: string): string[] {
  const out: string[] = [];
  const re = /\s*('(?:[^']|'')*'|&&|\|\||==|!=|[(),]|[A-Za-z_][\w.-]*)/y;
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
      try {
        return JSON.parse(arg) as Value;
      } catch {
        // GitHub never evaluates the operand a short-circuit skips; an
        // unparsable value is an error only when the result uses it.
        return BAD;
      }
    }
    if (t === "startsWith" || t === "contains") {
      take("(");
      const a = or();
      take(",");
      const b = or();
      take(")");
      const [x, y] = [
        String(a ?? "").toLowerCase(),
        String(b ?? "").toLowerCase(),
      ];
      return t === "startsWith" ? x.startsWith(y) : x.includes(y);
    }
    if (/^(vars|github|matrix|inputs)\./.test(t)) return lookup(ctx, t);
    throw new Error(`unsupported token: ${t}`);
  };
  const eq = (): Value => {
    const left = primary();
    const op = peek();
    if (op !== "==" && op !== "!=") return left;
    take(op);
    const same = equal(left, primary());
    return op === "==" ? same : !same;
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
  if (v === BAD)
    throw new Error(`fromJSON of a value that isn't JSON: ${expr}`);
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

// Issue 1492: the release dry run's switch, labels and guard.
const DRY_COND =
  "vars.DEN_RELEASE_SELF_HOSTED == 'on' && github.event_name == 'push' && " +
  "startsWith(github.ref, 'refs/tags/v') && contains(github.ref, '-dev.')";
const DRY_LABELS =
  'vars.DEN_RELEASE_RUNNER_LABELS || \'["self-hosted","den-wsl"]\'';
const DRY_RUNS_ON = `\${{ (${DRY_COND}) && fromJSON(${DRY_LABELS}) || 'ubuntu-latest' }}`;
const DRY_BOX_LABELS = `\${{ (${DRY_COND}) && (${DRY_LABELS}) || '' }}`;
const GATES_RUNS_ON =
  "${{ (inputs.box-labels != '' && github.event_name == 'push' && " +
  "startsWith(github.ref, 'refs/tags/v') && contains(github.ref, '-dev.')) && " +
  "fromJSON(inputs.box-labels) || 'ubuntu-latest' }}";
const RELEASE_BOX = ["self-hosted", "devbox"];
const RELEASE_ON = {
  DEN_RELEASE_SELF_HOSTED: "on",
  DEN_RELEASE_RUNNER_LABELS: JSON.stringify(RELEASE_BOX),
};

// Every switch on and every label set: a variable or input named *labels is
// a self-hosted label list, anything else is 'on'.
const ALL_ON = new Proxy({} as Record<string, unknown>, {
  get: (_t, key) =>
    typeof key === "string" && /labels/i.test(key)
      ? '["self-hosted","any"]'
      : "on",
});

// The events that can carry code that isn't ours, on any ref.
const FOREIGN = [
  prEvent("fork/den"),
  { ...prEvent("fork/den"), event_name: "pull_request_target" },
  { ...prEvent("fork/den"), event_name: "pull_request_review" },
  {
    event_name: "merge_group",
    repository: REPO,
    ref: "refs/heads/gh-readonly-queue/main/pr-1",
    event: {},
  },
  {
    event_name: "issue_comment",
    repository: REPO,
    ref: "refs/heads/main",
    event: {},
  },
  {
    event_name: "workflow_run",
    repository: REPO,
    ref: "refs/heads/main",
    event: {},
  },
].flatMap((g) => [
  { ...g, ref: (g as { ref?: string }).ref ?? "refs/pull/1/merge" },
  { ...g, ref: "refs/tags/v9.9.9-dev.1" },
]);

function workflowFiles(): string[] {
  return fs
    .readdirSync(WORKFLOWS)
    .filter((f) => /\.ya?ml$/.test(f))
    .sort();
}

// Each matrix combination a job can take; a matrix from an expression is
// tried with both supported Nodes.
function matrixValues(job: unknown): Record<string, unknown>[] {
  const m = (
    (job as Record<string, unknown>).strategy as
      | Record<string, unknown>
      | undefined
  )?.matrix as Record<string, unknown> | undefined;
  if (!m || typeof m !== "object") return [{}];
  let combos: Record<string, unknown>[] = [{}];
  for (const [k, v] of Object.entries(m)) {
    if (k === "include" || k === "exclude") continue;
    const values = Array.isArray(v) ? v : ["22.13.0", "24.13.0"];
    combos = combos.flatMap((c) => values.map((x) => ({ ...c, [k]: x })));
  }
  return combos;
}

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

  it("pull-request jobs: a same-repo PR goes to the box, any Node; a fork's and the merge queue never", () => {
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
      // A merge-queue run builds whatever was queued: GitHub-hosted.
      expect(
        evaluate(PR_GUARD, {
          vars: on,
          matrix: { node },
          github: { event_name: "merge_group", repository: REPO, event: {} },
        }),
      ).toBe("ubuntu-latest");
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

  // Issue 1492: the release dry run's serial jobs (plan, checks, pack) may
  // use the box, on a dev tag's push only; its test shards and every job of
  // the release itself stay GitHub-hosted.
  it("release-dry-run.yml: plan may use the box on a dev tag's push, and the watch guards it", () => {
    const w = workflow("release-dry-run.yml");
    expect(w.jobs.plan["runs-on"]).toBe(DRY_RUNS_ON);
    const gates = w.jobs.gates as Record<string, unknown>;
    expect((gates.with as Record<string, unknown>)["box-labels"]).toBe(
      DRY_BOX_LABELS,
    );
    const watch = w.jobs["box-watch"] as Record<string, unknown>;
    expect(watch.if).toBe(DRY_COND);
    expect(watch["runs-on"]).toBe("ubuntu-latest");
    expect(watch.permissions).toEqual({ actions: "write", contents: "read" });
    // the fallback is a run by hand on the same tag, in the same group
    const on = w.on as Record<string, unknown>;
    expect(Object.keys(on).sort()).toEqual(["push", "workflow_dispatch"]);
    expect(text("release-dry-run.yml")).toContain(
      "group: release-dry-run-${{ github.ref }}",
    );

    const tag = (ref: string, event = "push") => ({
      vars: RELEASE_ON,
      github: { event_name: event, repository: REPO, ref, event: {} },
    });
    expect(evaluate(DRY_RUNS_ON, tag("refs/tags/v0.4.90-dev.1"))).toEqual(
      RELEASE_BOX,
    );
    expect(evaluate(DRY_BOX_LABELS, tag("refs/tags/v0.4.90-dev.1"))).toBe(
      JSON.stringify(RELEASE_BOX),
    );
    // the watch's fallback (a run by hand), a branch, a release tag: hosted
    for (const ctx of [
      tag("refs/tags/v0.4.90-dev.1", "workflow_dispatch"),
      tag("refs/heads/main"),
      tag("refs/tags/v0.4.90"),
    ]) {
      expect(evaluate(DRY_RUNS_ON, ctx)).toBe("ubuntu-latest");
      expect(evaluate(DRY_BOX_LABELS, ctx)).toBe("");
    }
    // the switch off, or unset: hosted, whatever the labels say
    const off = {
      vars: { DEN_RELEASE_RUNNER_LABELS: RELEASE_ON.DEN_RELEASE_RUNNER_LABELS },
      github: tag("refs/tags/v0.4.90-dev.1").github,
    };
    expect(evaluate(DRY_RUNS_ON, off)).toBe("ubuntu-latest");
    // unset labels: the same default as ci.yml's
    expect(
      evaluate(DRY_RUNS_ON, {
        vars: { DEN_RELEASE_SELF_HOSTED: "on" },
        github: tag("refs/tags/v0.4.90-dev.1").github,
      }),
    ).toEqual(SELF_HOSTED);
  });

  it("release-gates.yml: checks and pack take the caller's box labels only on a dev tag's push; the tests stay hosted", () => {
    const jobs = workflow("release-gates.yml").jobs;
    expect(jobs.checks["runs-on"]).toBe(GATES_RUNS_ON);
    expect(jobs.pack["runs-on"]).toBe(GATES_RUNS_ON);
    expect(jobs.tests["runs-on"]).toBe("ubuntu-latest");
    const labels = JSON.stringify(RELEASE_BOX);
    const ctx = (ref: string, boxLabels: string, event = "push") => ({
      inputs: { "box-labels": boxLabels },
      github: { event_name: event, repository: REPO, ref, event: {} },
    });
    expect(
      evaluate(GATES_RUNS_ON, ctx("refs/tags/v0.4.90-dev.1", labels)),
    ).toEqual(RELEASE_BOX);
    // release.yml passes no labels, and runs by hand on main
    expect(evaluate(GATES_RUNS_ON, ctx("refs/heads/main", ""))).toBe(
      "ubuntu-latest",
    );
    expect(
      evaluate(
        GATES_RUNS_ON,
        ctx("refs/heads/main", labels, "workflow_dispatch"),
      ),
    ).toBe("ubuntu-latest");
    expect(evaluate(GATES_RUNS_ON, ctx("refs/heads/x", labels))).toBe(
      "ubuntu-latest",
    );
  });

  it("release.yml never uses the box: every job is GitHub-hosted, and passes no box labels", () => {
    const w = workflow("release.yml");
    for (const [name, job] of Object.entries(w.jobs))
      expect({ job: name, "runs-on": job["runs-on"] ?? "(reusable)" }).toEqual({
        job: name,
        "runs-on":
          job["runs-on"] === undefined ? "(reusable)" : "ubuntu-latest",
      });
    expect(text("release.yml")).not.toMatch(
      /box-labels|self-hosted|DEN_RELEASE_SELF_HOSTED/,
    );
  });

  it("a job that publishes or holds a production secret is GitHub-hosted in every workflow (an environment, or id-token: write)", () => {
    for (const file of workflowFiles()) {
      for (const [name, job] of Object.entries(workflow(file).jobs)) {
        const j = job as Record<string, unknown>;
        const perms = (j.permissions ?? {}) as Record<string, unknown>;
        if (j.environment === undefined && perms["id-token"] !== "write")
          continue;
        expect({ file, job: name, "runs-on": j["runs-on"] }).toEqual({
          file,
          job: name,
          "runs-on": "ubuntu-latest",
        });
      }
    }
  });

  // Vision, issue 1492: the repo is public, so any job that can land on a
  // self-hosted label runs only when the code is ours: a push or a run by
  // hand here, or a pull request whose head branch lives here. Every
  // workflow and every job is tried with each switch on, any label, every
  // matrix value, and each event that can carry someone else's code. A
  // runs-on this evaluator can't read fails too: it can't be shown safe.
  it("no job in any workflow can reach a self-hosted runner with code that isn't ours", () => {
    const files = workflowFiles();
    expect(files).toEqual(
      expect.arrayContaining([
        "ci.yml",
        "release-dry-run.yml",
        "release-gates.yml",
        "repeat.yml",
      ]),
    );
    let tried = 0;
    for (const file of files) {
      for (const [name, job] of Object.entries(workflow(file).jobs)) {
        const runsOn = (job as Record<string, unknown>)["runs-on"];
        if (runsOn === undefined) continue; // a reusable workflow's call: its own jobs are scanned in its file
        if (typeof runsOn !== "string" || !runsOn.includes("${{")) {
          expect({
            file,
            job: name,
            hosted: !/self-hosted/i.test(JSON.stringify(runsOn)),
          }).toEqual({ file, job: name, hosted: true });
          continue;
        }
        for (const matrix of matrixValues(job))
          for (const github of FOREIGN) {
            tried++;
            const got = evaluate(runsOn, {
              vars: ALL_ON,
              inputs: ALL_ON,
              matrix,
              github,
            });
            expect({ file, job: name, event: github.event_name, got }).toEqual({
              file,
              job: name,
              event: github.event_name,
              got: "ubuntu-latest",
            });
          }
      }
    }
    expect(tried).toBeGreaterThan(0);
  });

  it("the scan fails a job that can reach the box without the guard", () => {
    const unguarded =
      "${{ vars.DEN_SELF_HOSTED == 'on' && fromJSON(vars.DEN_SELF_HOSTED_LABELS || '[\"self-hosted\"]') || 'ubuntu-latest' }}";
    const reached = FOREIGN.map((github) =>
      evaluate(unguarded, { vars: ALL_ON, inputs: ALL_ON, matrix: {}, github }),
    );
    expect(reached.every((r) => Array.isArray(r))).toBe(true);
    expect(() =>
      evaluate("${{ needs.plan.outputs.box }}", { github: {} }),
    ).toThrow();
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
      evaluate(NIGHT_GUARD, {
        vars: { DEN_SELF_HOSTED_NIGHT: "on" },
        github: BY_HAND,
      }),
    ).toEqual(SELF_HOSTED);
    expect(
      evaluate(NIGHT_GUARD, {
        vars: { DEN_SELF_HOSTED: "on" },
        github: BY_HAND,
      }),
    ).toBe("ubuntu-latest");
    expect(evaluate(NIGHT_GUARD, { vars: {}, github: BY_HAND })).toBe(
      "ubuntu-latest",
    );
    // Issue 1492: only a run by hand, whatever starts it later
    expect(
      evaluate(NIGHT_GUARD, {
        vars: { DEN_SELF_HOSTED_NIGHT: "on" },
        github: prEvent("fork/den"),
      }),
    ).toBe("ubuntu-latest");
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
