/**
 * A pull request's state from gh, to confirm a merge an agent ran
 * (session rotation's "PR merged" trigger, den#4). It runs gh, which asks
 * GitHub; usage itself stays local (src/shared/usage never sends).
 */
import { execFile } from "child_process";

/**
 * `gh pr view [<ref>] [-R <repo>] --json number,state`: the state and the
 * number (a bare ref is the branch's PR, and the number names it). Rejects
 * on any error, or an answer that isn't that JSON. Only the ref and repo
 * go out, to GitHub, by gh.
 */
export function ghPrState(env: NodeJS.ProcessEnv) {
  return (ref: string, o: { repo?: string; cwd: string }) =>
    new Promise<{ state: string; number?: number }>((res, rej) => {
      const args = [
        "pr",
        "view",
        ...(ref ? [ref] : []),
        ...(o.repo ? ["-R", o.repo] : []),
        "--json",
        "number,state",
      ];
      execFile(
        "gh",
        args,
        { cwd: o.cwd, env, timeout: 15_000, maxBuffer: 64 * 1024 },
        (e, stdout) => {
          if (e) return rej(e);
          try {
            const o = JSON.parse(String(stdout)) as Record<string, unknown>;
            if (typeof o.state !== "string") throw new Error("no state");
            res({
              state: o.state,
              ...(typeof o.number === "number" ? { number: o.number } : {}),
            });
          } catch (err) {
            rej(err);
          }
        },
      );
    });
}
