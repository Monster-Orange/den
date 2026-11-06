/**
 * Den's built-in runtimes, registered as strategy kind `runtime`: import
 * this module to have them. den-claude first: it is the default.
 */
import { denClaude } from "./den-claude.js";
import { generic } from "./generic.js";
import { allScrubEnv, registerRuntime, type Runtime } from "./runtime.js";
import { ACTOR_TOKEN_ENV } from "../actor-token.js";
import { AGENT_ACTOR_ENV, buildSessionEnv } from "../sessions/env.js";

registerRuntime(denClaude);
registerRuntime(generic);

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

/**
 * An agent's session env, as `agents start` builds it and `doctor --probe`
 * checks it: the allowlist, the runtime's passthrough and launch env, Den's
 * markers (DEN_AGENT=agent:<id>, and SEC-1c's DEN_ACTOR_TOKEN when one was
 * minted), then every runtime's scrubEnv and any person credential.
 */
export function agentSessionEnv(
  caller: NodeJS.ProcessEnv,
  rt: Pick<Runtime, "envPassthrough">,
  launch: Record<string, string>,
  agentId: string,
  /** SEC-1c: the agent's actor token (`agents start` mints it; the probe has none). */
  actorToken?: string,
): Record<string, string> {
  return buildSessionEnv({
    caller,
    passthrough: rt.envPassthrough,
    launch,
    // The seam for a persona's or runtime's declared env: none yet.
    extra: {},
    den: {
      [AGENT_ACTOR_ENV]: `agent:${agentId}`,
      ...(actorToken ? { [ACTOR_TOKEN_ENV]: actorToken } : {}),
    },
    scrub: allScrubEnv(),
  });
}
