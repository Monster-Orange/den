import chalk from "chalk";
import type { AliasResolver } from "../../shared/environment-manager/derivation/alias.js";
import {
  followTailSources,
  resolveTailSources,
} from "../../shared/environment-manager/log-tail.js";
import type { ResolvedService } from "../../shared/types/index.js";
import { resolveCwdRepo } from "./invocation-target.js";

import { product } from "../../shared/product.js";
export type LogsTarget =
  | { kind: "repo"; target: string }
  | { kind: "address"; target: string }
  | { kind: "unknown-repo"; arg: string }
  | { kind: "no-cwd-repo" };

/**
 * `den logs [repo]` target resolution: an explicit arg is alias-resolved
 * against the known repo-systems (a `repo/subsystem` address passes through
 * untouched); with no arg, the cwd repo is used.
 */
export function resolveLogsTarget(
  args: string[],
  alias: AliasResolver,
  cwdRepo: () => { repo: string; root: string } | null = () =>
    resolveCwdRepo(alias),
): LogsTarget {
  const arg = args.find((a) => !a.startsWith("-"));
  if (arg) {
    if (arg.includes("/")) return { kind: "address", target: arg };
    const resolved = alias.resolve(arg);
    const repo =
      resolved && alias.knownRepos.has(resolved)
        ? resolved
        : alias.knownRepos.has(arg)
          ? arg
          : undefined;
    return repo
      ? { kind: "repo", target: repo }
      : { kind: "unknown-repo", arg };
  }
  const cwd = cwdRepo();
  return cwd ? { kind: "repo", target: cwd.repo } : { kind: "no-cwd-repo" };
}

/**
 * Tail the service's live logs to stdout until the stream ends or the user
 * hits Ctrl-C. Returns the exit code the CLI should finish with.
 * `waitForSourceMs` keeps polling for a log source to appear — used right
 * after starting a service, when its container/daemon log may not exist yet
 * (e.g. tab-runtime ups write no daemon file until the container is up).
 */
export async function tailServiceLogs(
  resolved: ResolvedService,
  opts: { waitForSourceMs?: number } = {},
): Promise<number> {
  let candidates = resolveTailSources(resolved);
  if (candidates.length === 0 && opts.waitForSourceMs) {
    const deadline = Date.now() + opts.waitForSourceMs;
    while (candidates.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      candidates = resolveTailSources(resolved);
    }
  }
  if (candidates.length === 0) {
    console.log(
      chalk.yellow(`\n  No local log source found for ${resolved.address}.`),
    );
    console.log(
      chalk.gray(
        `  (no manifest logs.local command, no running container, and no ${product().cli}`,
      ),
    );
    console.log(
      chalk.gray(
        `  daemon log — services started outside ${product().cli} don't get one; '${product().cli} up ${resolved.repoName}' does.)\n`,
      ),
    );
    return 1;
  }

  console.log(
    chalk.gray(`\n  Tailing logs for ${resolved.address} — Ctrl-C to stop.`),
  );
  const handle = followTailSources(candidates, {
    onLine: (line) => console.log(line),
    onMeta: (line) => console.log(chalk.gray(`  ${line}`)),
  });
  // Ctrl-C stops the tail (the child shares our process group); SIGTERM/SIGHUP
  // land only on this process, so without stop() they'd orphan a live
  // `docker logs -f`/`tail -F` child.
  const onSignal = (): void => handle.stop();
  const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
  for (const sig of signals) process.once(sig, onSignal);
  // `den logs x | head` closes stdout mid-stream: without a handler the
  // next console.log crashes node with an unhandled EPIPE and orphans the
  // detached tail child. Standard pipe semantics: stop tailing, exit clean.
  const onStdoutError = (): void => handle.stop();
  process.stdout.on("error", onStdoutError);
  const code = await handle.done;
  for (const sig of signals) process.removeListener(sig, onSignal);
  process.stdout.removeListener("error", onStdoutError);
  return code;
}
