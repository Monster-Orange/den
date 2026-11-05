/**
 * Stacks come from two places:
 *  - a repo's own `.den.yml` `compose:` section (preferred), for every
 *    repo in the focused workspace;
 *  - `stacks:` in config/den.yml, for repos that don't carry a manifest.
 * A manifest stack wins over a config stack of the same name.
 */
import * as fs from "fs";
import * as path from "path";
import * as yaml from "yaml";
import { getDistRoot } from "../paths.js";
import { readCatalog } from "../environment-manager/catalog.js";
import {
  getActiveWorkspace,
  getWorkspaceByName,
  listWorkspaceServices,
} from "../environment-manager/workspaces.js";
import { readManifest } from "../manifest/read-manifest.js";
import type { ManifestComposeConfig } from "../types/index.js";
import { assertSecretEnvSpec } from "../secrets/secret-env.js";
import { assertStackName, parseTarget } from "./render.js";
import type { StackConfig } from "./types.js";

import { product } from "../product.js";
type Raw = Partial<Omit<StackConfig, "name">>;

function list(v: unknown, what: string): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string"))
    throw new Error(`${what} must be a list of strings`);
  return v as string[];
}

function toStack(
  name: string,
  raw: Raw | ManifestComposeConfig,
  repo: string,
  repoPath: string | undefined,
  where: string,
): StackConfig {
  assertStackName(name);
  const routes = raw.routes ?? {};
  Object.values(routes).forEach(parseTarget);
  const files = list(raw.files, `${where}.files`);
  const secretEnv =
    "secret_env" in raw
      ? assertSecretEnvSpec(raw.secret_env, `${where}.secret_env`)
      : undefined;
  return {
    name,
    repo,
    ...(repoPath ? { repoPath } : {}),
    dir: raw.dir,
    files: files.length ? files : ["docker-compose.yml"],
    routes,
    generate: list(raw.generate, `${where}.generate`),
    uses: list(raw.uses, `${where}.uses`),
    env: Object.fromEntries(
      Object.entries(raw.env ?? {}).map(([k, v]) => [k, String(v)]),
    ),
    profiles: list(raw.profiles, `${where}.profiles`),
    ...("healthchecks" in raw && raw.healthchecks
      ? { healthchecks: raw.healthchecks }
      : {}),
    ...("service_env" in raw && raw.service_env
      ? {
          serviceEnv: Object.fromEntries(
            Object.entries(raw.service_env).map(([svc, vars]) => [
              svc,
              Object.fromEntries(
                Object.entries(vars).map(([k, v]) => [k, String(v)]),
              ),
            ]),
          ),
        }
      : {}),
    ...(secretEnv && Object.keys(secretEnv).length ? { secretEnv } : {}),
  };
}

/** Stack name for a repo's manifest compose section. */
export function manifestStackName(
  manifest: { name: string; compose?: ManifestComposeConfig },
  repoName: string,
): string {
  return manifest.compose?.name ?? manifest.name ?? repoName;
}

/** `compose:` stacks declared by repos in a workspace (default: focused). */
export function readManifestStacks(
  workspace?: string,
): Record<string, StackConfig> {
  const ws = workspace ? getWorkspaceByName(workspace) : getActiveWorkspace();
  if (!ws) return {};
  const out: Record<string, StackConfig> = {};
  const seen = new Set<string>();
  for (const svc of listWorkspaceServices(ws.config, readCatalog(), ws.name)) {
    if (seen.has(svc.repoPath) || !fs.existsSync(svc.repoPath)) continue;
    seen.add(svc.repoPath);
    const m = readManifest(svc.repoPath);
    if (!m?.compose) continue;
    const name = manifestStackName(m, svc.repoName);
    out[name] = toStack(
      name,
      m.compose,
      svc.repoName,
      svc.repoPath,
      `${svc.repoName}/${product().manifestYml} compose`,
    );
  }
  return out;
}

export function readStacks(
  root: string = getDistRoot(),
  opts: { workspace?: string; manifests?: boolean } = {},
): Record<string, StackConfig> {
  let parsed: { stacks?: Record<string, Raw> } | null = null;
  try {
    parsed = yaml.parse(
      fs.readFileSync(path.join(root, product().configFile), "utf-8"),
    );
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const out: Record<string, StackConfig> = {};
  for (const [name, raw] of Object.entries(parsed?.stacks ?? {})) {
    if (!raw?.repo) throw new Error(`stacks.${name}.repo is required`);
    out[name] = toStack(name, raw, raw.repo, undefined, `stacks.${name}`);
  }
  if (opts.manifests !== false)
    Object.assign(out, readManifestStacks(opts.workspace));

  // `uses` may name a stack or the repo that declares it.
  const byRepo = new Map(Object.values(out).map((s) => [s.repo, s.name]));
  for (const s of Object.values(out)) {
    s.uses = s.uses.map((u) => (out[u] ? u : (byRepo.get(u) ?? u)));
    for (const u of s.uses)
      if (!out[u])
        throw new Error(`stack ${s.name}: uses names unknown stack "${u}"`);
  }
  return out;
}
