/**
 * H5: how much of each GitHub org Den Hub's GitHub App can read, live from
 * Hub (GITHUB-COVERAGE-API.md §2); null when Hub isn't connected here. The
 * server's Settings rows and the CLI's doctor both ask it.
 */
import {
  hubGithubCoverage,
  readHubConfig,
  readHubToken,
  scrubToken,
} from "./hub.js";
import { readCoverage, type OrgCoverage } from "./hub-project-sync.js";

export async function githubCoverage(): Promise<
  { orgs: OrgCoverage[] } | { error: string } | null
> {
  const cfg = readHubConfig();
  if (!cfg) return null;
  const token = await readHubToken(cfg);
  if (!token) return null;
  try {
    return { orgs: readCoverage(await hubGithubCoverage(cfg.url, token)) };
  } catch (e) {
    return { error: scrubToken(String((e as Error)?.message ?? e), token) };
  }
}
