/**
 * Issue 936: a session's argv as the runtime gets it, with the agent
 * sandbox's wrapper taken off. A launch where the OS sandbox applies
 * starts `bwrap <flags> -- <runtime> <args>` (Linux) or
 * `sandbox-exec -p <profile> <runtime> <args>` (macOS); tests that read
 * the runtime's own args read them through this.
 */
import * as path from "path";

export function runtimeArgs(m: { file: string; args: string[] }): string[] {
  const tool = path.basename(m.file);
  if (tool === "bwrap") {
    const end = m.args.indexOf("--");
    return end < 0 ? m.args : m.args.slice(end + 2);
  }
  if (tool === "sandbox-exec" && m.args[0] === "-p") return m.args.slice(3);
  return m.args;
}
