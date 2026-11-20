/**
 * Issue 615: every dev tag runs the release's own checks, tests and pack
 * with the release's versions, and publishes nothing.
 *
 * - release-gates.yml holds the checks, the tests and the pack, once. The
 *   release (release.yml) and the dry run (release-dry-run.yml) both call
 *   it, so their steps can't drift apart.
 * - The dry run runs on a pushed tag v*-dev.* only, reads the repository
 *   only, and has no job or step that tags, publishes or makes a GitHub
 *   release, and no npm token or OIDC token.
 */
import { describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import * as yaml from "yaml";

const DIR = path.join(process.cwd(), ".github", "workflows");
const GATES = "./.github/workflows/release-gates.yml";

interface Step {
  name?: string;
  id?: string;
  if?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
  env?: Record<string, unknown>;
}
interface Job {
  needs?: string | string[];
  if?: string;
  uses?: string;
  with?: Record<string, unknown>;
  secrets?: unknown;
  permissions?: unknown;
  outputs?: Record<string, unknown>;
  steps?: Step[];
}
interface Workflow {
  on: unknown;
  permissions?: unknown;
  jobs: Record<string, Job>;
}

const text = (f: string): string => fs.readFileSync(path.join(DIR, f), "utf8");
const wf = (f: string): Workflow => yaml.parse(text(f)) as Workflow;
const needs = (j: Job | undefined): string[] =>
  ([] as string[]).concat(j?.needs ?? []);

describe("release-gates.yml: the release's checks, tests and pack, in one place", () => {
  it("is a reusable workflow, with the versions to apply as optional inputs", () => {
    const w = wf("release-gates.yml");
    const on = w.on as { workflow_call?: { inputs?: Record<string, unknown> } };
    expect(Object.keys(w.on as object)).toEqual(["workflow_call"]);
    for (const i of ["den-version", "kit-version", "changelog-date"])
      expect(on.workflow_call?.inputs?.[i]).toBeDefined();
    expect(Object.keys(w.jobs).sort()).toEqual(["checks", "pack", "tests"]);
    expect(w.permissions).toEqual({ contents: "read" });
  });

  it("every job applies the versions right after its checkout and setup, before npm ci, only when given", () => {
    const w = wf("release-gates.yml");
    for (const [name, job] of Object.entries(w.jobs)) {
      const steps = job.steps ?? [];
      const at = steps.findIndex((s) =>
        /scripts\/release-dry-run\.mjs apply\b/.test(s.run ?? ""),
      );
      expect([name, at]).toEqual([name, 2]);
      expect(steps[0].uses).toMatch(/^actions\/checkout@/);
      expect(steps[1].uses).toMatch(/^actions\/setup-node@/);
      expect(steps[at].if).toBe("inputs.den-version != ''");
      const ci = steps.findIndex((s) => s.run === "npm ci");
      expect([name, ci > at]).toEqual([name, true]);
    }
  });

  it("hands the tarball's name on", () => {
    const on = wf("release-gates.yml").on as {
      workflow_call: { outputs?: Record<string, { value?: string }> };
    };
    expect(on.workflow_call.outputs?.tarball?.value).toBe(
      "${{ jobs.pack.outputs.tarball }}",
    );
  });
});

describe("release.yml calls the gates and publishes only after them", () => {
  const w = wf("release.yml");

  it("one job calls release-gates.yml with no versions (the commit's own)", () => {
    const callers = Object.entries(w.jobs).filter(([, j]) => j.uses === GATES);
    expect(callers.map(([n]) => n)).toEqual(["gates"]);
    expect(w.jobs.gates.with).toBeUndefined();
    expect(needs(w.jobs.gates)).toEqual(["check"]);
  });

  it("the tag, the publish, the GitHub release and the kit wait on the gates", () => {
    for (const j of ["tag", "publish", "github-release", "den-ui"]) {
      const seen = new Set<string>();
      const up = (n: string): void => {
        for (const m of needs(w.jobs[n]))
          if (!seen.has(m)) {
            seen.add(m);
            up(m);
          }
      };
      up(j);
      expect([j, seen.has("gates")]).toEqual([j, true]);
    }
  });

  it("the publish takes the tarball's name from the gates", () => {
    expect(JSON.stringify(w.jobs.publish)).toContain(
      "needs.gates.outputs.tarball",
    );
    expect(text("release.yml")).not.toMatch(/needs\.pack\./);
  });
});

describe("release-dry-run.yml: the release on every dev tag, publishing nothing", () => {
  const w = wf("release-dry-run.yml");
  const raw = text("release-dry-run.yml");

  it("runs on a pushed tag v*-dev.* only", () => {
    expect(w.on).toEqual({ push: { tags: ["v*-dev.*"] } });
  });

  it("reads the repository only: no write, no OIDC token, anywhere", () => {
    expect(w.permissions).toEqual({ contents: "read" });
    for (const [name, job] of Object.entries(w.jobs))
      expect([name, job.permissions]).toEqual([name, undefined]);
    expect(raw).not.toMatch(/id-token|:\s*write\b/);
  });

  it("has no tag, publish, GitHub release or kit job", () => {
    expect(Object.keys(w.jobs).sort()).toEqual(["gates", "plan"]);
    for (const j of ["tag", "publish", "github-release", "den-ui"])
      expect(w.jobs[j]).toBeUndefined();
  });

  it("no step tags, pushes, publishes or makes a release, and no npm token is there", () => {
    expect(raw).not.toMatch(/npm publish|git tag|git push|gh release/);
    expect(raw).not.toMatch(/NPM_TOKEN|NODE_AUTH_TOKEN|registry-url/);
    expect(raw).not.toMatch(/secrets:\s*inherit/);
    const gates = text("release-gates.yml");
    expect(gates).not.toMatch(
      /npm publish|git tag|git push|gh release|id-token|NPM_TOKEN|NODE_AUTH_TOKEN|registry-url/,
    );
  });

  it("passes only the org-name list on, never every secret", () => {
    expect(w.jobs.gates.secrets).toEqual({
      DEN_ORG_NAMES: "${{ secrets.DEN_ORG_NAMES }}",
    });
  });

  it("the plan decides the versions at the tag; the gates run them", () => {
    const plan = w.jobs.plan;
    const co = (plan.steps ?? []).find((s) =>
      s.uses?.startsWith("actions/checkout@"),
    );
    // the kit's history since the commit npm has, to see whether it changed
    expect(Number(co?.with?.["fetch-depth"])).toBe(0);
    expect(
      (plan.steps ?? []).some((s) =>
        /scripts\/release-dry-run\.mjs plan "\$GITHUB_REF_NAME"/.test(
          s.run ?? "",
        ),
      ),
    ).toBe(true);
    expect(w.jobs.gates.uses).toBe(GATES);
    expect(needs(w.jobs.gates)).toEqual(["plan"]);
    expect(w.jobs.gates.with).toEqual({
      "den-version": "${{ needs.plan.outputs.den }}",
      "kit-version": "${{ needs.plan.outputs.kit }}",
      "changelog-date": "${{ needs.plan.outputs.date }}",
    });
  });
});

describe("every action in the release's workflows is pinned by its commit", () => {
  it.each(["release.yml", "release-gates.yml", "release-dry-run.yml"])(
    "%s",
    (f) => {
      const uses = [...text(f).matchAll(/^\s*(?:-\s+)?uses:\s*(\S+)/gm)].map(
        (m) => m[1],
      );
      expect(uses.length).toBeGreaterThan(0);
      for (const u of uses)
        if (!u.startsWith("./"))
          expect([u, /@[0-9a-f]{40}$/.test(u)]).toEqual([u, true]);
    },
  );
});
