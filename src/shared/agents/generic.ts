/**
 * generic: any CLI, from the persona's argv template (AG spec §4):
 *
 *   argv: ["aider", "--model", "{model}", "--mcp-config", "{mcp_config}"]
 *
 * `{model}` is the agent's model; `{mcp_config}` is the path of a per-agent
 * MCP config (0600) holding Den's scoped server, written only when the
 * template references it. A CLI that speaks no MCP gets a terminal and no
 * Den tools. generic declares no resume.
 */
import {
  LaunchError,
  mcpConfigJson,
  mcpConfigPath,
  type LaunchOutput,
  type Runtime,
} from "./runtime.js";

export const GENERIC_ID = "generic";

export const generic: Runtime = {
  id: GENERIC_ID,
  // The CLI is the persona's; there is nothing to look for until launch.
  detect: () => ({ available: true }),
  scrubEnv: [],
  launch(input): LaunchOutput {
    const template = input.persona.argv;
    if (!template?.length)
      throw new LaunchError(
        `${GENERIC_ID}: persona ${input.persona.id} has no argv template (argv: [...] in its front matter)`,
      );
    const usesModel = template.some((a) => a.includes("{model}"));
    if (usesModel && !input.model)
      throw new LaunchError(
        `${GENERIC_ID}: persona ${input.persona.id}'s argv uses {model}; give --model or set model in the persona`,
      );
    const file = mcpConfigPath(input);
    const usesMcp = template.some((a) => a.includes("{mcp_config}"));
    const argv = template.map((a) =>
      a
        .split("{model}")
        .join(input.model ?? "")
        .split("{mcp_config}")
        .join(file),
    );
    return {
      argv,
      env: {},
      ...(usesMcp ? { files: { [file]: mcpConfigJson(input.mcp) } } : {}),
    };
  },
};
