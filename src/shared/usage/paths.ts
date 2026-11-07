/**
 * Where Claude Code keeps its transcripts. No registration here, so the
 * den-claude runtime can ask (conversationExists) without loading the
 * usage sources (sources.ts registers one when it loads).
 */
import * as os from "os";
import * as path from "path";

/** Claude Code's transcripts: $CLAUDE_CONFIG_DIR/projects, else ~/.claude/projects. */
export function claudeProjectsDir(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const base =
    env.CLAUDE_CONFIG_DIR || path.join(env.HOME || os.homedir(), ".claude");
  return path.join(base, "projects");
}
