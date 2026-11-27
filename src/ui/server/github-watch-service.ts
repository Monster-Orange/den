/**
 * The server's one shared GitHub watcher (github-watch/watcher.ts) and its
 * loop: every PUMP_MS it looks whether a round is due (the watcher keeps
 * its own pace, backoff and pauses) and tells finished watches' agents.
 *
 * GitHub calls go through `gh` as the person running the server
 * (report-routes.ts runGh), with `gh api -i` so the rate-limit headers
 * come back. The watches are kept in <state>/github/watches.json across a
 * restart; doctor and `<cli> github status` read
 * <state>/github/watch-status.json.
 */
import * as path from "node:path";
import { readUserConfig } from "../../shared/den-config.js";
import { ghGet } from "../../shared/github-watch/gh-http.js";
import { githubWatchSettings } from "../../shared/github-watch/settings.js";
import { watchStatusFile } from "../../shared/github-watch/status-line.js";
import { GithubWatcher } from "../../shared/github-watch/watcher.js";
import type { Delivery } from "../../shared/hub/hub-delivery.js";
import { getStateDir } from "../../shared/paths.js";
import { runGh } from "./report-routes.js";

/** How often the loop looks whether a round is due, and tells agents. */
const PUMP_MS = 5000;

let watcher: GithubWatcher | null = null;
let timer: NodeJS.Timeout | null = null;
let relay: (dv: Delivery) => Promise<boolean> = async () => false;

/** The install's watcher (made on first use). */
export function githubWatcher(): GithubWatcher {
  if (!watcher)
    watcher = new GithubWatcher({
      get: ghGet(runGh),
      settings: () => {
        try {
          return githubWatchSettings(readUserConfig());
        } catch {
          return githubWatchSettings({});
        }
      },
      relay: (dv) => relay(dv),
      file: path.join(getStateDir(), "github", "watches.json"),
      statusFile: watchStatusFile(getStateDir()),
    });
  return watcher;
}

/** Starts the loop; `relayTo` holds a line for an agent, typed at its prompt. */
export function startGithubWatch(d: {
  relay: (dv: Delivery) => Promise<boolean>;
  log?: (line: string) => void;
}): void {
  relay = d.relay;
  const w = githubWatcher();
  if (timer) clearInterval(timer);
  let busy = false;
  timer = setInterval(() => {
    if (busy) return;
    busy = true;
    w.tick()
      .then(() => w.deliver())
      .catch((e) =>
        d.log?.(
          `github watch: ${String((e as Error)?.message ?? e).slice(0, 200)}`,
        ),
      )
      .finally(() => (busy = false));
  }, PUMP_MS);
  timer.unref();
}
