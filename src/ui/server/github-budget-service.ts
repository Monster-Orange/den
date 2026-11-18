/**
 * Issue 487: the server's one GitHub budget and CI watcher, opened on
 * first use. GitHub is asked through the person's own gh (`gh api -i`,
 * client.ts): gh keeps its sign-in, and Den's process never holds it.
 * The settings are read from user.yml on each use.
 */
import { readUserConfig } from "../../shared/den-config.js";
import { GithubBudget } from "../../shared/github-budget/budget.js";
import { CiWatcher } from "../../shared/github-budget/ci-watcher.js";
import {
  createGhCliHttp,
  type GithubHttp,
} from "../../shared/github-budget/client.js";
import {
  githubBudgetPaths,
  githubBudgetSettings,
  type GithubBudgetSettings,
} from "../../shared/github-budget/settings.js";

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
  const http =
    o.http ??
    createGhCliHttp({
      timeoutMs: () => githubBudgetSettingsNow().ghTimeoutSeconds * 1000,
    });
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
