/**
 * Issue 498: only a release candidate's run may take the release slot.
 *
 * `gate run --kind release --tag <tag> [--repo <dir>]` proves it by its
 * tag, read from the repo's own git (never from what the caller says):
 *  - the name is a release or a dev tag: vX.Y.Z or vX.Y.Z-dev.N;
 *  - the tag exists and is annotated (a tag object, as release tags and
 *    dev tags are; a plain lightweight ref is no proof);
 *  - its commit is the version-setting commit: its package.json version is
 *    the tag's version;
 *  - it is recent: tagged within `release_tag_max_age_hours`, so an old
 *    tag can't be reused to go ahead of the queue.
 * The slot log records the tag, its commit and who asked.
 */
import { execFileSync } from "child_process";

export type ReleaseProof =
  | { ok: true; tag: string; commit: string; taggedAt: string }
  | { ok: false; error: string };

export const RELEASE_TAG_RE = /^v(\d+\.\d+\.\d+(?:-dev\.\d+)?)$/;

/** Runs git in `repo`; its trimmed output, or null when it fails. */
export type GitRun = (repo: string, args: string[]) => string | null;

const realGit: GitRun = (repo, args) => {
  try {
    return execFileSync("git", ["-C", repo, ...args], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
};

export function proveReleaseTag(
  tag: string,
  repo: string,
  maxAgeHours: number,
  now: number,
  git: GitRun = realGit,
): ReleaseProof {
  const m = RELEASE_TAG_RE.exec(tag);
  if (!m)
    return {
      ok: false,
      error: `${tag} is not a release candidate's tag (vX.Y.Z or vX.Y.Z-dev.N)`,
    };
  if (git(repo, ["rev-parse", "--git-dir"]) === null)
    return { ok: false, error: `${repo} is not a git repo` };
  const type = git(repo, ["cat-file", "-t", `refs/tags/${tag}`]);
  if (type === null) return { ok: false, error: `no tag ${tag} in ${repo}` };
  if (type !== "tag")
    return {
      ok: false,
      error: `${tag} is not an annotated tag; a release candidate's tag is`,
    };
  const commit = git(repo, ["rev-parse", `refs/tags/${tag}^{commit}`]);
  if (!commit || !/^[0-9a-f]{40,64}$/.test(commit))
    return { ok: false, error: `${tag} names no commit` };
  let version: unknown;
  try {
    version = (
      JSON.parse(git(repo, ["show", `${commit}:package.json`]) ?? "") as {
        version?: unknown;
      }
    ).version;
  } catch {
    version = undefined;
  }
  if (version !== m[1])
    return {
      ok: false,
      error: `${tag}'s commit sets version ${String(version ?? "none")}, not ${m[1]}`,
    };
  const unix = Number(
    git(repo, [
      "for-each-ref",
      "--format=%(taggerdate:unix)",
      `refs/tags/${tag}`,
    ]),
  );
  if (!Number.isFinite(unix) || unix <= 0)
    return { ok: false, error: `${tag} has no tag date` };
  const hours = (now - unix * 1000) / 3_600_000;
  if (hours > maxAgeHours)
    return {
      ok: false,
      error: `${tag} is ${Math.floor(hours)} hours old, too old for a candidate (release_tag_max_age_hours ${maxAgeHours})`,
    };
  return {
    ok: true,
    tag,
    commit,
    taggedAt: new Date(unix * 1000).toISOString(),
  };
}
