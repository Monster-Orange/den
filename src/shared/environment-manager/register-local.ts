/**
 * `den register <path>`: add an existing checkout to a workspace, with no
 * prompts.
 *
 * The repo is named after its manifest (`name:`), so a checkout can live
 * anywhere on disk (Arbor lives outside the repos root) and still get a clean
 * name. It is added dev-managed at that path: Den runs the repo's own
 * commands there and never clones or switches its branch. One bare entry per
 * repo: the workspace expands it to every service in the manifest.
 */

import * as fs from "fs";
import * as path from "path";
import { readManifest } from "../manifest/read-manifest.js";
import { getGitHubCoords } from "../smoke/git-remote.js";
import { upsertCatalogEntry } from "./catalog.js";
import { readWorkspacesFile, writeWorkspacesFile } from "./workspaces.js";

import { product } from "../product.js";
export interface RegisteredRepo {
  repoName: string;
  gh: string;
  path: string;
  services: string[];
}

export function registerLocalRepo(
  repoPathArg: string,
  workspaceName: string,
): RegisteredRepo {
  const repoPath = path.resolve(repoPathArg);
  if (!fs.existsSync(repoPath))
    throw new Error(`Path does not exist: ${repoPath}`);
  const manifest = readManifest(repoPath);
  if (!manifest)
    throw new Error(
      `No ${product().manifestYml} in ${repoPath} (and none in ${product().title}'s manifests/ for its origin repo)`,
    );
  const repoName =
    typeof manifest.name === "string" && manifest.name
      ? manifest.name
      : path.basename(repoPath);
  const coords = getGitHubCoords(repoPath);
  const gh = coords ? `${coords.owner}/${coords.repo}` : "";

  const file = readWorkspacesFile();
  const ws = file.workspaces[workspaceName];
  if (!ws) throw new Error(`Unknown project "${workspaceName}"`);

  // Replace every existing entry for this repo, keeping its auto-start toggle.
  let autostartOff = false;
  for (const key of Object.keys(ws.services)) {
    if (key === repoName || key.startsWith(`${repoName}/`)) {
      if (ws.services[key].autostart === false) autostartOff = true;
      delete ws.services[key];
    }
  }
  ws.services[repoName] = {
    mode: "dev-managed",
    path: repoPath,
    ...(autostartOff ? { autostart: false } : {}),
  };

  upsertCatalogEntry(repoName, { gh });
  writeWorkspacesFile(file);
  return {
    repoName,
    gh,
    path: repoPath,
    services: Object.keys(manifest.services ?? {}),
  };
}
