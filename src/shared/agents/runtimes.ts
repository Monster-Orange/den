/**
 * Den's built-in runtimes, registered as strategy kind `runtime`: import
 * this module to have them. den-claude first: it is the default.
 */
import { denClaude } from "./den-claude.js";
import { generic } from "./generic.js";
import { registerRuntime } from "./runtime.js";

registerRuntime(denClaude);
registerRuntime(generic);

export {
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
