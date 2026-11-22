/**
 * Issue 478: a push to main cancels an older main CI run only when it
 * supersedes it (the new commit descends from it), never a release
 * commit's run, and never one it doesn't descend from. Pull-request runs
 * and release.yml's concurrency are unchanged.
 */
import { describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import * as yaml from "yaml";
import { execFileSync } from "child_process";

const SCRIPT = path.resolve(__dirname, "../../../scripts/ci-supersede.mjs");
/** The script's own functions, run in node (an ES module): `expr`'s value. */
const inNode = (expr: string): unknown =>
  JSON.parse(
    execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { decide, isReleaseCommit } from ${JSON.stringify(
          "file://" + SCRIPT,
        )}; console.log(JSON.stringify(${expr}));`,
      ],
      { encoding: "utf8" },
    ),
  );
const decide = (a: unknown) =>
  inNode(`decide(${JSON.stringify(a)})`) as { cancel: boolean; why: string };
const isReleaseCommit = (sha: string, v: Record<string, string>) =>
  inNode(
    `isReleaseCommit(${JSON.stringify(sha)}, (r) => (${JSON.stringify(v)})[r] ?? null)`,
  ) as boolean;

const DIR = path.join(process.cwd(), ".github", "workflows");
const wf = (f: string) =>
  yaml.parse(fs.readFileSync(path.join(DIR, f), "utf8")) as Record<
    string,
    unknown
  >;

describe("two back-to-back pushes to main", () => {
  it("the newer descends from the older: cancel", () => {
    expect(
      decide({
        older: { sha: "aaa", release: false },
        newerSha: "bbb",
        descends: true,
      }),
    ).toMatchObject({ cancel: true });
  });

  it("the older is a release commit: keep", () => {
    const d = decide({
      older: { sha: "aaa", release: true },
      newerSha: "bbb",
      descends: true,
    });
    expect(d.cancel).toBe(false);
    expect(d.why).toMatch(/release/);
  });

  it("the newer doesn't descend from it (a force-push): keep", () => {
    const d = decide({
      older: { sha: "aaa", release: false },
      newerSha: "bbb",
      descends: false,
    });
    expect(d.cancel).toBe(false);
    expect(d.why).toMatch(/doesn't descend/);
  });

  it("its own commit: keep", () => {
    expect(
      decide({
        older: { sha: "bbb", release: false },
        newerSha: "bbb",
        descends: true,
      }).cancel,
    ).toBe(false);
  });
});

describe("a release commit: its version differs from its first parent's", () => {
  it("changed: a release commit", () => {
    expect(isReleaseCommit("c", { c: "0.4.81", "c^1": "0.4.81-dev.3" })).toBe(
      true,
    );
  });
  it("the same: not one", () => {
    expect(isReleaseCommit("c", { c: "0.4.81", "c^1": "0.4.81" })).toBe(false);
  });
  it("unknown: not one", () => {
    expect(isReleaseCommit("c", { c: "0.4.81" })).toBe(false);
  });
});

describe("the workflows", () => {
  it("ci-supersede runs on a push to main, outside ci.yml's group, and may cancel runs", () => {
    const w = wf("ci-supersede.yml");
    expect(w.on).toEqual({ push: { branches: ["main"] } });
    expect(w.permissions).toEqual({ contents: "read", actions: "write" });
    expect(w.concurrency).toBeUndefined();
    expect(JSON.stringify(w.jobs)).toContain("scripts/ci-supersede.mjs");
  });

  it("ci.yml still cancels only pull-request runs; release.yml's concurrency unchanged", () => {
    expect(wf("ci.yml").concurrency).toEqual({
      group: "ci-${{ github.event_name }}-${{ github.ref }}",
      "cancel-in-progress": "${{ github.event_name == 'pull_request' }}",
    });
    expect(wf("release.yml").concurrency).toEqual({
      group: "release",
      "cancel-in-progress": false,
    });
  });
});
