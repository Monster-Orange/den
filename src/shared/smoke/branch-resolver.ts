/**
 * Deployed branch/SHA resolver
 *
 * Uses the GitHub Deployments API (via `gh`) to find the exact commit SHA
 * that is currently deployed to a given environment.  This is the authoritative
 * source of truth — more precise than a branch name, and independent of what
 * happens to be on the local machine.
 *
 * Flow:
 *   1. GET /repos/{owner}/{repo}/deployments?environment={env}&per_page=20
 *   2. Walk deployments newest-first, fetch each one's statuses
 *   3. Return the first deployment whose latest status is "success"
 *
 * Why not just take deployment[0]?  A deployment record is created when a
 * deploy *starts*, not when it *succeeds*.  If the most recent deploy is still
 * in progress or failed, we want the last known-good one.
 *
 * Requires: `gh` CLI authenticated (`gh auth login`).
 */

import { execSync } from "child_process";

export interface DeployedRef {
  /** Exact commit SHA deployed to this environment. */
  sha: string;
  /** Branch the commit was deployed from (informational). */
  ref: string;
  /** GitHub environment name. */
  environment: string;
  /** ISO timestamp of the deployment. */
  deployedAt: string;
  /** GitHub deployment ID. */
  deploymentId: number;
}

interface GhDeployment {
  id: number;
  sha: string;
  ref: string;
  environment: string;
  created_at: string;
  statuses_url: string;
}

interface GhDeploymentStatus {
  state: string; // "success" | "failure" | "error" | "pending" | "in_progress" | "queued" | "inactive"
}

function gh(args: string): string {
  try {
    return execSync(`gh ${args}`, {
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf-8",
    }).trim();
  } catch (err) {
    const msg = (err as { stderr?: string }).stderr?.trim() ?? String(err);
    throw new Error(`gh command failed: ${msg}`);
  }
}

/**
 * Fetch the latest deployment status state for a deployment.
 * Returns null if no statuses exist yet (deployment just created).
 */
function getLatestDeploymentState(
  owner: string,
  repo: string,
  deploymentId: number,
): string | null {
  try {
    const raw = gh(
      `api "/repos/${owner}/${repo}/deployments/${deploymentId}/statuses?per_page=1"`,
    );
    const statuses: GhDeploymentStatus[] = JSON.parse(raw);
    return statuses[0]?.state ?? null;
  } catch {
    return null;
  }
}

/**
 * Resolve the latest *successfully* deployed ref for a repo+environment.
 *
 * @param owner       GitHub org/user (e.g. "acme")
 * @param repo        GitHub repo name (e.g. "api")
 * @param environment GitHub environment name (e.g. "staging")
 * @param limit       Max deployments to inspect before giving up (default 20)
 */
export async function resolveDeployedRef(
  owner: string,
  repo: string,
  environment: string,
  limit = 20,
): Promise<DeployedRef> {
  // Check gh is available and authenticated
  try {
    gh("auth status --active");
  } catch {
    throw new Error("GitHub CLI is not authenticated. Run: gh auth login");
  }

  const raw = gh(
    `api "/repos/${owner}/${repo}/deployments?environment=${environment}&per_page=${limit}"`,
  );
  const deployments: GhDeployment[] = JSON.parse(raw);

  if (!deployments.length) {
    throw new Error(
      `No deployments found for ${owner}/${repo} on environment "${environment}". ` +
        `Has it been deployed via GitHub Actions?`,
    );
  }

  // Walk newest-first, find the last successful one
  for (const d of deployments) {
    const state = getLatestDeploymentState(owner, repo, d.id);
    if (state === "success") {
      return {
        sha: d.sha,
        ref: d.ref,
        environment: d.environment,
        deployedAt: d.created_at,
        deploymentId: d.id,
      };
    }
  }

  // No successful deployment found in the window — warn and use most recent
  const latest = deployments[0];
  console.warn(
    `  ⚠  No successful deployment found for ${owner}/${repo}@${environment} ` +
      `in the last ${limit} deploys. Using most recent (${latest.sha.slice(0, 8)}).`,
  );
  return {
    sha: latest.sha,
    ref: latest.ref,
    environment: latest.environment,
    deployedAt: latest.created_at,
    deploymentId: latest.id,
  };
}
