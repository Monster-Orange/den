/**
 * The kit's version rule (scripts/kit-version.mjs), on every pull request
 * and at release.
 *
 * A kit fix landed after its version was on npm, with that version
 * unchanged: the release saw "on npm already", skipped publishing, and the
 * fix never reached the kit's npm users. Now a change to packages/den-ui
 * since the commit npm's copy was built from (npm's gitHead, or else the
 * commit that set the version), while that version is on npm, fails: in
 * CI's checks on every pull request, in the release dry run, and in the
 * release's den-ui job. It says to bump the kit's package.json and its
 * package-lock.json entry together. A prerelease, or a version npm doesn't
 * have, passes.
 *
 * checkKit takes its npm and git calls as arguments: each case hands it
 * stubs (a "world"), in a child Node, as the script is plain ESM.
 */
import { describe, expect, it } from "@jest/globals";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as yaml from "yaml";

const ROOT = path.join(__dirname, "../../..");
const KIT = "@scope-x/kit";
const NPM_HEAD = "a".repeat(40);
const SET_VERSION = "b".repeat(40);

interface World {
  kit: string; // packages/den-ui/package.json's version
  lock?: string; // package-lock.json's "packages/den-ui" version (default: kit)
  npm: "missing" | "down" | Record<string, string | null>; // version → gitHead
  commits?: string[]; // the commits git knows
  changed?: Record<string, string>; // base sha → files changed since, in packages/den-ui
  shallow?: boolean;
}

interface Result {
  ok: boolean;
  version?: string;
  publish?: boolean;
  error?: string;
  output?: string;
  notes: string[];
  gitCalls: string[][];
}

/** checkKit(stubs) in a child Node: what it returned, or the error it threw. */
function check(world: World): Result {
  const js = `
    const { checkKit, githubOutput, KitError } = await import("./scripts/kit-version.mjs");
    const w = ${JSON.stringify(world)};
    const notes = [], gitCalls = [];
    const deps = {
      readJson: (f) => {
        if (f === "packages/den-ui/package.json") return { name: ${JSON.stringify(KIT)}, version: w.kit };
        if (f === "package-lock.json") return { packages: { "packages/den-ui": { version: w.lock ?? w.kit } } };
        throw new Error("unexpected read " + f);
      },
      npmView: (spec, field) => {
        if (w.npm === "down") throw new KitError("::error::npm view " + spec + " " + field + " failed (not a 404)");
        if (w.npm === "missing") return null;
        if (field === "name") return spec;
        const v = spec.slice(spec.lastIndexOf("@") + 1);
        if (!(v in w.npm)) return null;
        if (field === "version") return v;
        if (field === "gitHead") return w.npm[v] ?? "";
        throw new Error("unexpected field " + field);
      },
      git: (...args) => {
        gitCalls.push(args);
        if (args[0] === "log") return ${JSON.stringify(SET_VERSION)};
        if (args[0] === "diff") return (w.changed ?? {})[args[2]] ?? "";
        throw new Error("unexpected git " + args.join(" "));
      },
      isCommit: (sha) => (w.commits ?? []).includes(sha),
      isShallow: () => Boolean(w.shallow),
      note: (s) => notes.push(s),
    };
    let out;
    try {
      const r = checkKit(deps);
      out = { ok: true, ...r, output: githubOutput(r), notes, gitCalls };
    } catch (e) {
      if (!(e instanceof KitError)) throw e;
      out = { ok: false, error: e.message, notes, gitCalls };
    }
    console.log(JSON.stringify(out));`;
  return JSON.parse(
    execFileSync(process.execPath, ["--input-type=module", "-e", js], {
      cwd: ROOT,
      encoding: "utf-8",
    }),
  ) as Result;
}

const KIT_FILE = "packages/den-ui/src/kit.js";

describe("checkKit: the kit's version rule", () => {
  it("the kit changed since npm's copy, and its version is on npm: fails, and says to bump both files together", () => {
    const r = check({
      kit: "0.9.0",
      npm: { "0.9.0": NPM_HEAD },
      commits: [NPM_HEAD, SET_VERSION],
      changed: { [NPM_HEAD]: KIT_FILE },
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/^::error::/);
    expect(r.error).toContain("0.9.0");
    expect(r.error).toContain(KIT_FILE);
    expect(r.error).toMatch(/bump/i);
    expect(r.error).toContain("packages/den-ui/package.json");
    expect(r.error).toContain('package-lock.json entry ("packages/den-ui")');
    expect(r.error).toMatch(/together/);
    expect(r.error).toContain(NPM_HEAD.slice(0, 9));
  });

  it("no gitHead on npm (or one git doesn't know): compares with the commit that set the version", () => {
    for (const npm of [{ "0.9.0": null }, { "0.9.0": NPM_HEAD }]) {
      const r = check({
        kit: "0.9.0",
        npm,
        commits: [SET_VERSION], // npm's gitHead, if any, isn't in this history
        changed: { [SET_VERSION]: KIT_FILE },
      });
      expect(r.ok).toBe(false);
      expect(r.error).toContain(SET_VERSION.slice(0, 9));
      expect(r.gitCalls[0][0]).toBe("log");
    }
  });

  it("the kit unchanged since npm's copy: passes, nothing to publish", () => {
    const r = check({
      kit: "0.9.0",
      npm: { "0.9.0": NPM_HEAD },
      commits: [NPM_HEAD],
      changed: {},
    });
    expect(r.ok).toBe(true);
    expect(r.publish).toBe(false);
    expect(r.output).toBe("version=0.9.0\ngo=no\n");
  });

  it("a version npm doesn't have yet: passes, and the release publishes it", () => {
    const r = check({
      kit: "0.9.1",
      npm: { "0.9.0": NPM_HEAD },
      commits: [NPM_HEAD],
      changed: { [NPM_HEAD]: KIT_FILE },
    });
    expect(r.ok).toBe(true);
    expect(r.publish).toBe(true);
    expect(r.output).toBe("version=0.9.1\ngo=yes\n");
    expect(r.gitCalls).toEqual([]);
  });

  it("the kit not on npm at all: passes, its first publish is by hand", () => {
    const r = check({ kit: "0.1.0", npm: "missing" });
    expect(r.ok).toBe(true);
    expect(r.publish).toBe(false);
    expect(r.notes.join("\n")).toMatch(/by hand/);
  });

  it("a prerelease: passes, never published, even when the kit changed", () => {
    const r = check({
      kit: "0.9.1-dev.2",
      npm: { "0.9.1-dev.2": NPM_HEAD },
      commits: [NPM_HEAD],
      changed: { [NPM_HEAD]: KIT_FILE },
    });
    expect(r.ok).toBe(true);
    expect(r.publish).toBe(false);
    expect(r.output).toBe("version=0.9.1-dev.2\ngo=no\n");
  });

  it("package-lock.json's kit entry differs from the kit's package.json: fails, and says to bump both", () => {
    const r = check({ kit: "0.9.1", lock: "0.9.0", npm: { "0.9.0": null } });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("package-lock.json");
    expect(r.error).toContain("0.9.1");
    expect(r.error).toContain("0.9.0");
    expect(r.error).toMatch(/together/);
  });

  it("a shallow clone can't see the base commit: fails rather than pass by not looking", () => {
    const r = check({
      kit: "0.9.0",
      npm: { "0.9.0": NPM_HEAD },
      shallow: true,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/fetch-depth: 0/);
  });

  it("the registry errors (not a 404): fails rather than guess", () => {
    const r = check({ kit: "0.9.0", npm: "down" });
    expect(r.ok).toBe(false);
  });
});

type Step = {
  id?: string;
  name?: string;
  uses?: string;
  run?: string;
  if?: string;
  with?: Record<string, unknown>;
};
type Job = { steps: Step[] };
const workflow = (f: string): { jobs: Record<string, Job> } =>
  yaml.parse(fs.readFileSync(path.join(ROOT, ".github/workflows", f), "utf8"));

describe("the workflows run the rule", () => {
  it("release.yml's den-ui job decides with the script: no path skips a kit that changed", () => {
    const job = workflow("release.yml").jobs["den-ui"];
    const checkout = job.steps.find((s) =>
      s.uses?.startsWith("actions/checkout"),
    );
    // the base commit is in the history only with all of it
    expect(checkout?.with?.["fetch-depth"]).toBe(0);
    const decide = job.steps.find((s) => s.id === "ui");
    // Main's own copy decides (issue 922): a job that can publish never
    // runs the promoted tree's scripts.
    expect(decide?.run?.trim()).toBe(
      'node .release-main/scripts/kit-version.mjs >> "$GITHUB_OUTPUT"',
    );
    // no step of its own decides to skip: "on npm already" only comes from the script
    for (const s of job.steps) {
      expect(s.run ?? "").not.toMatch(/npm view/);
      expect(s.run ?? "").not.toMatch(/Skipped/);
    }
    // every other run step waits for the script's go
    for (const s of job.steps.filter((s) => s.run && s.id !== "ui"))
      expect(s.if).toBe("steps.ui.outputs.go == 'yes'");
  });

  it("ci.yml runs it in the fast checks on every pull request and push to main", () => {
    const jobs = workflow("ci.yml").jobs;
    const runs = (j: Job) => j.steps.map((s) => s.run ?? "");
    const fast = Object.entries(jobs).filter(([, j]) =>
      runs(j).some((r) => r.includes("scripts/brittle-ratchet.mjs")),
    );
    expect(fast.length).toBeGreaterThan(0);
    for (const [name, j] of fast) {
      expect([name, runs(j).includes("node scripts/kit-version.mjs")]).toEqual([
        name,
        true,
      ]);
      const checkout = j.steps.find((s) =>
        s.uses?.startsWith("actions/checkout"),
      );
      expect([name, checkout?.with?.["fetch-depth"]]).toEqual([name, 0]);
    }
  });
});
