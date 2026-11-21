/**
 * `<cli> github status [--json]`: the shared GitHub watcher's line (calls
 * left, the reset, the active watches, the interval; paused, why and until
 * when), from the server's <state>/github/watch-status.json. No server
 * call and no GitHub call.
 */
import { getStateDir } from "../../shared/paths.js";
import {
  githubWatchLine,
  readWatchStatus,
} from "../../shared/github-watch/status-line.js";
import { product } from "../../shared/product.js";

export const GITHUB_HELP = {
  usage: "github status [--json]",
  lines: [
    "The shared GitHub watcher agents use (MCP github_watch) instead of `gh … --watch`:",
    "  status [--json]   GitHub calls left, the reset, active watches, the interval",
  ],
};

export interface GithubCommandDeps {
  stateDir?: string;
  out?: (line: string) => void;
  err?: (line: string) => void;
}

export async function cmdGithub(
  args: string[],
  d: GithubCommandDeps = {},
): Promise<number> {
  const out = d.out ?? ((l: string) => console.log(l));
  const err = d.err ?? ((l: string) => console.error(l));
  const [sub = "status", ...rest] = args;
  if (sub !== "status" || rest.some((a) => a !== "--json")) {
    let cli = "den";
    try {
      cli = product().cli;
    } catch {
      /* the default name */
    }
    err(`usage: ${cli} ${GITHUB_HELP.usage}`);
    for (const l of GITHUB_HELP.lines) err(l);
    return 2;
  }
  const s = readWatchStatus(d.stateDir ?? getStateDir());
  if (rest.includes("--json")) {
    out(JSON.stringify(s, null, 2));
    return 0;
  }
  const l = githubWatchLine(s);
  out(
    l
      ? `github watch  ${l.ok ? "✓" : "⚠"}  ${l.text}`
      : "github watch  no GitHub watch status yet: Den writes it once an agent asks for a watch.",
  );
  return 0;
}
