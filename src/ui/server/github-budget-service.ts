/**
 * Issue 487: the server's one GitHub budget and CI watcher, opened on
 * first use. GitHub is reached over HTTP with the person's own gh sign-in
 * (`gh auth token`, read once and again after a 401; never logged), at
 * DEN_GITHUB_API_URL when set (a test's fake), else api.github.com.
 * The settings are read from user.yml on each use.
 */
import { execFile } from "child_process";
import { promisify } from "util";
import { readUserConfig } from "../../shared/den-config.js";
import { GithubBudget } from "../../shared/github-budget/budget.js";
import { CiWatcher } from "../../shared/github-budget/ci-watcher.js";
import {
  createGithubHttp,
  GITHUB_API,
  type GithubHttp,
} from "../../shared/github-budget/client.js";
import {
  githubBudgetPaths,
  githubBudgetSettings,
  type GithubBudgetSettings,
} from "../../shared/github-budget/settings.js";
import { GH_API_TIMEOUT_MS } from "../../shared/constants.js";

const execFileAsync = promisify(execFile);

export interface GithubBudgetService {
  budget: GithubBudget;
  watcher: CiWatcher;
  settings: () => GithubBudgetSettings;
}

export function githubBudgetSettingsNow(): GithubBudgetSettings {
  try {
    return githubBudgetSettings(readUserConfig().github_budget);
  } catch {
    return githubBudgetSettings(undefined);
  }
}

export function createGithubBudgetService(
  o: { dir?: string; http?: GithubHttp } = {},
): GithubBudgetService {
  let token: Promise<string | null> | null = null;
  const readToken = () =>
    (token ??= execFileAsync("gh", ["auth", "token"], {
      timeout: GH_API_TIMEOUT_MS,
      encoding: "utf-8",
    })
      .then((r) => r.stdout.trim() || null)
      .catch(() => {
        token = null;
        return null;
      }));
  const base = createGithubHttp({
    apiBase: process.env.DEN_GITHUB_API_URL || GITHUB_API,
    token: readToken,
  });
  // A 401 drops the token, so a new sign-in is picked up.
  const http: GithubHttp = o.http ?? {
    async get(p, etag) {
      const r = await base.get(p, etag);
      if (r.status === 401) token = null;
      return r;
    },
    rateLimit: () => base.rateLimit(),
  };
  const files = githubBudgetPaths(o.dir);
  const budget = new GithubBudget({
    snapshotFile: files.snapshot,
    spendFile: files.spend,
    reserve: () => githubBudgetSettingsNow().reserve,
    readRateLimit: () => http.rateLimit(),
  });
  const watcher = new CiWatcher({
    http,
    budget,
    pollSeconds: () => githubBudgetSettingsNow().pollSeconds,
  });
  return { budget, watcher, settings: githubBudgetSettingsNow };
}
