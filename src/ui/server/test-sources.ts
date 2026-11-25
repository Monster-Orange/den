import { execFile } from "child_process";
import { GIT_REMOTE_TIMEOUT_MS } from "../../shared/constants.js";
import { mapLimited } from "../../shared/map-limited.js";

export type GitRead = (
  gitArgs: string[],
  cwd: string,
) => Promise<string | null>;

export const readGitField: GitRead = (gitArgs, cwd) =>
  new Promise((resolve) => {
    execFile(
      "git",
      gitArgs,
      { cwd, encoding: "utf-8", timeout: GIT_REMOTE_TIMEOUT_MS },
      (err, stdout) => resolve(err ? null : stdout.trim() || null),
    );
  });

const BRANCH = ["rev-parse", "--abbrev-ref", "HEAD"];
const SHORT = ["rev-parse", "--short", "HEAD"];

export async function readRepoHeads<R extends { repoPath: string }>(
  repos: readonly R[],
  atOnce: number,
  read: GitRead = readGitField,
): Promise<(R & { branch: string | null; shortSha: string | null })[]> {
  const reads = repos.flatMap((r) => [
    { cwd: r.repoPath, args: BRANCH },
    { cwd: r.repoPath, args: SHORT },
  ]);
  const out = await mapLimited(reads, atOnce, (x) => read(x.args, x.cwd));
  return repos.map((r, i) => ({
    ...r,
    branch: out[2 * i],
    shortSha: out[2 * i + 1],
  }));
}
