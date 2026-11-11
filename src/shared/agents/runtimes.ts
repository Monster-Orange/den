/**
 * Den's built-in runtimes, registered as strategy kind `runtime`: import
 * this module to have them. den-claude first: it is the default. Then the
 * rest of the runtime catalog (AG-0.5: codex, gemini, grok), then generic.
 * Entries a distribution or user.yml adds are registered by
 * syncConfiguredRuntimes, after the built-ins.
 */
import { BUILTIN_CATALOG, type CatalogEntry } from "./catalog.js";
import { catalogRuntime } from "./catalog-runtime.js";
import { denClaude } from "./den-claude.js";
import { generic } from "./generic.js";
import {
  allScrubEnv,
  getRuntime,
  registerRuntime,
  runtimeIds,
  unregisterRuntime,
  type Runtime,
} from "./runtime.js";
import { sessionPath, type RuntimeFind } from "./runtime-search.js";
import { ACTOR_TOKEN_ENV } from "../actor-token.js";
import { AGENT_ACTOR_ENV, buildSessionEnv } from "../sessions/env.js";

registerRuntime(denClaude);
for (const e of BUILTIN_CATALOG)
  if (e.id !== denClaude.id) registerRuntime(catalogRuntime(e));
registerRuntime(generic);

let configured: string[] = [];

/**
 * Register the catalog entries a distribution and user.yml add (already
 * checked: catalog.ts validateCatalog), replacing the last set: an entry
 * taken out of the config is no runtime any more.
 */
export function syncConfiguredRuntimes(entries: readonly CatalogEntry[]): void {
  const ids = entries.map((e) => e.id);
  for (const id of configured) if (!ids.includes(id)) unregisterRuntime(id);
  for (const e of entries) registerRuntime(catalogRuntime(e));
  configured = ids;
}

export {
  allScrubEnv,
  DEFAULT_RUNTIME_ID,
  getRuntime,
  LaunchError,
  RUNTIME_KIND,
  runtimeIds,
  type AgentMcp,
  type LaunchInput,
  type LaunchOutput,
  type ResumeInput,
  type Runtime,
} from "./runtime.js";

/** Every registered runtime's find (its well-known directories). */
export function allRuntimeFinds(): (RuntimeFind | undefined)[] {
  return runtimeIds().map((id) => getRuntime(id)?.find);
}

/**
 * The caller's env with the PATH a session gets (AG-0.1): the login
 * shell's PATH, the caller's, then every runtime's install directories
 * that exist, and `extraDirs` (a configured CLI's directory).
 */
export function withSessionPath(
  caller: NodeJS.ProcessEnv,
  extraDirs: readonly string[] = [],
): NodeJS.ProcessEnv {
  const PATH = sessionPath(caller, allRuntimeFinds(), extraDirs);
  return PATH === caller.PATH ? caller : { ...caller, PATH };
}

/**
 * An agent's session env, as `agents start` builds it and `doctor --probe`
 * checks it: the allowlist (its PATH the search's, withSessionPath), the runtime's passthrough and launch env, Den's
 * markers (DEN_AGENT=agent:<id>, and SEC-1c's DEN_ACTOR_TOKEN when one was
 * minted), then every runtime's scrubEnv and any person credential.
 */
export function agentSessionEnv(
  caller: NodeJS.ProcessEnv,
  rt: Pick<Runtime, "envPassthrough" | "launchEnv">,
  launch: Record<string, string>,
  agentId: string,
  /** SEC-1c: the agent's actor token (`agents start` mints it; the probe has none). */
  actorToken?: string,
  /** Added to its PATH: the directory of the CLI it runs. */
  extraDirs: readonly string[] = [],
): Record<string, string> {
  return buildSessionEnv({
    caller: withSessionPath(caller, extraDirs),
    passthrough: rt.envPassthrough,
    launch,
    // The seam for a persona's or runtime's declared env: none yet.
    extra: {},
    den: {
      [AGENT_ACTOR_ENV]: `agent:${agentId}`,
      ...(actorToken ? { [ACTOR_TOKEN_ENV]: actorToken } : {}),
    },
    scrub: allScrubEnv(),
    ownLaunch: rt.launchEnv ?? [],
  });
}
