/**
 * H5: how much of each GitHub org Den Hub's GitHub App can read, live from
 * Hub (GITHUB-COVERAGE-API.md §2); null when Hub isn't connected here. The
 * server's Settings rows and the CLI's doctor both ask it.
 */
import {
  HubCallError,
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
    return { error: coverageError(e, token) };
  }
}

/**
 * The words for a failed ask. A 404 is a Hub that hasn't this route yet
 * (an older Hub), not a refusal (the 0.4.40 gate's doctor note).
 */
export function coverageError(e: unknown, token: string): string {
  if (e instanceof HubCallError && e.status === 404)
    return "not available on this Hub yet";
  return scrubToken(String((e as Error)?.message ?? e), token);
}
