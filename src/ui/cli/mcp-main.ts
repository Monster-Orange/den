/**
 * Entry point for `<cli> mcp` (bin/den routes `mcp` here). Kept apart from
 * the main CLI so nothing but the MCP protocol is ever written to stdout.
 */
// Issue 1038: first, so no module or child sees the caller record.
import "../../shared/caller-env-take.js";
import "./mcp-stdout-guard.js";
import { runMcp } from "../mcp/server.js";

runMcp(process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write(
    `mcp: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
