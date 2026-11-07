/**
 * A pull request's state from gh, to confirm a merge an agent ran
 * (session rotation's "PR merged" trigger, den#4). It runs gh, which asks
 * GitHub; usage itself stays local (src/shared/usage never sends).
 */
import { execFile } from "child_process";

/**
 * `gh pr view [<ref>] [-R <repo>] --json state -q .state`;
 * rejects on any error. Only the ref and repo go out, to GitHub, by gh.
 */
export function ghPrState(env: NodeJS.ProcessEnv) {
  return (ref: string, o: { repo?: string; cwd: string }) =>
    new Promise<string | undefined>((res, rej) => {
      const args = [
        "pr",
        "view",
        ...(ref ? [ref] : []),
        ...(o.repo ? ["-R", o.repo] : []),
        "--json",
        "state",
        "-q",
        ".state",
      ];
      execFile(
        "gh",
        args,
        { cwd: o.cwd, env, timeout: 15_000, maxBuffer: 64 * 1024 },
        (e, stdout) => (e ? rej(e) : res(String(stdout).trim())),
      );
    });
}
