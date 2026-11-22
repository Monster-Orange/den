#!/usr/bin/env node
/**
 * Issue 478: a push to main cancels an older main CI run it supersedes.
 *
 * ci.yml's concurrency group never cancels a main run, so a newer push
 * queues behind the older run (pending) until it ends. This runs in its
 * own workflow (ci-supersede.yml) as soon as main is pushed: for each
 * ci.yml run on main still in progress or queued, older than this push,
 * it decides (decide()) and cancels only a superseded one:
 *
 *   - the new commit descends from the run's commit: cancel;
 *   - the run's commit is a release commit (its package.json version
 *     differs from its first parent's): keep, release.yml depends on it,
 *     and the newer run queues behind it as before;
 *   - the new commit doesn't descend from it (a force-push): keep.
 *
 * Every decision is logged in this run (and its step summary), with the
 * run, its commit and why. Pull-request runs and release.yml's own
 * concurrency are untouched.
 *
 *   GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_SHA (from the workflow)
 *   node scripts/ci-supersede.mjs [--dry-run]
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { pathToFileURL } from "node:url";

/**
 * The decision for one older run. `older`: { sha, release }; `descends`:
 * whether the new commit has the run's commit as an ancestor.
 */
export function decide({ older, newerSha, descends }) {
  if (older.sha === newerSha)
    return { cancel: false, why: "the same commit as this push" };
  if (older.release)
    return {
      cancel: false,
      why: "a release commit (its version differs from its first parent's): release.yml depends on its run, so the newer run waits for it",
    };
  if (!descends)
    return {
      cancel: false,
      why: "this push doesn't descend from it (a force-push?): not superseded",
    };
  return { cancel: true, why: "superseded: this push contains its commit" };
}

const git = (args) =>
  execFileSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

/** package.json's version at `rev`, or null. */
function versionAt(rev) {
  try {
    return JSON.parse(git(["show", `${rev}:package.json`])).version ?? null;
  } catch {
    return null;
  }
}

/** Whether `sha` is a release commit: its version differs from its first parent's. */
export function isReleaseCommit(sha, at = versionAt) {
  const v = at(sha);
  const p = at(`${sha}^1`);
  return v !== null && p !== null && v !== p;
}

function descendsFrom(oldSha, newSha) {
  try {
    git(["cat-file", "-e", `${oldSha}^{commit}`]);
  } catch {
    try {
      git(["fetch", "--quiet", "--no-tags", "origin", oldSha]);
    } catch {
      return false;
    }
  }
  try {
    git(["merge-base", "--is-ancestor", oldSha, newSha]);
    return true;
  } catch {
    return false;
  }
}

async function api(path, init = {}) {
  const r = await fetch(`https://api.github.com/${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!r.ok && r.status !== 202)
    throw new Error(`${init.method ?? "GET"} ${path}: ${r.status}`);
  return r.status === 202 || r.status === 204 ? null : r.json();
}

async function main() {
  const dry = process.argv.includes("--dry-run");
  const repo = process.env.GITHUB_REPOSITORY;
  const sha = process.env.GITHUB_SHA;
  if (!repo || !sha)
    throw new Error("GITHUB_REPOSITORY and GITHUB_SHA are needed");
  const lines = [];
  const say = (l) => {
    console.log(l);
    lines.push(l);
  };
  const runs = [];
  for (const status of ["in_progress", "queued"]) {
    const b = await api(
      `repos/${repo}/actions/workflows/ci.yml/runs?branch=main&event=push&status=${status}&per_page=50`,
    );
    runs.push(...(b?.workflow_runs ?? []));
  }
  const mine = runs.find((r) => r.head_sha === sha);
  const older = runs.filter(
    (r) =>
      r.head_sha !== sha &&
      (!mine || Date.parse(r.created_at) < Date.parse(mine.created_at)),
  );
  if (!older.length)
    say(
      `No older main CI run is in progress for ${sha.slice(0, 7)}: nothing to cancel.`,
    );
  for (const r of older) {
    const d = decide({
      older: { sha: r.head_sha, release: isReleaseCommit(r.head_sha) },
      newerSha: sha,
      descends: descendsFrom(r.head_sha, sha),
    });
    const what = `ci run ${r.id} (${r.head_sha.slice(0, 7)}, ${r.status})`;
    if (d.cancel && !dry)
      await api(`repos/${repo}/actions/runs/${r.id}/cancel`, {
        method: "POST",
      });
    say(
      `${d.cancel ? (dry ? "Would cancel" : "Cancelled") : "Kept"} ${what}: ${d.why}.`,
    );
  }
  if (process.env.GITHUB_STEP_SUMMARY)
    fs.appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `### Superseded main CI runs\n\n${lines.map((l) => `- ${l}`).join("\n")}\n`,
    );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
  main().catch((e) => {
    // Never fail the push for this: the older run just finishes.
    console.log(`Not decided: ${e.message}. The older run, if any, runs on.`);
  });
