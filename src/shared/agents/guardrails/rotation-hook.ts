/**
 * Den's session-rotation hook for Claude Code sessions it launches
 * (den#4). One script for two events, run with the agent's own files dir
 * and its limit:
 *
 *   rotation-hook.ts --files <agent files dir> --after <n>   (0: never rotates)
 *
 * Hook contract (https://code.claude.com/docs/en/hooks):
 *   - PreCompact: JSON on stdin with the common fields (`session_id`,
 *     `transcript_path`, `cwd`, `hook_event_name`) and `trigger` (manual or
 *     auto) and `custom_instructions`. Exit 0's stdout becomes instructions
 *     for the compaction summary. It runs before Claude Code decides to
 *     compact ("Not enough messages to compact" still runs it), so it never
 *     counts. When this compaction would make a rotation due, its stdout
 *     asks the summary to keep the instruction to write the handoff.
 *   - SessionStart, with `source` "compact" (after a compaction that
 *     happened) or "resume". "compact" counts the compaction in
 *     rotation.json (rotation.ts). While a rotation is due, it prints
 *     `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":…}}`,
 *     which Claude Code adds to the context: write handoff.md, then end
 *     the turn.
 *
 * The parser is tolerant: a field it doesn't find is left out, never an
 * error. Any error lets Claude Code carry on (exit 0, nothing printed):
 * the hook never blocks a compaction.
 */
import {
  dueFor,
  noteCompaction,
  notePendingCompaction,
  readHandoff,
  readRotation,
  rotationInstruction,
} from "../rotation.js";

export interface RotationHookArgs {
  files: string;
  after: number;
}

/** `--files <dir> --after <n>`; null when either is missing. */
export function parseHookArgs(
  argv: readonly string[],
): RotationHookArgs | null {
  const at = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const files = at("--files");
  const after = Number(at("--after") ?? "");
  if (!files || !Number.isInteger(after) || after < 0) return null;
  return { files, after };
}

/** The hook's stdout for one input ("" prints nothing). */
export function rotationHookOutput(
  input: unknown,
  args: RotationHookArgs,
  now: Date = new Date(),
): string {
  if (!input || typeof input !== "object") return "";
  const i = input as Record<string, unknown>;
  const event = i.hook_event_name;
  const conversation =
    typeof i.session_id === "string" && i.session_id ? i.session_id : undefined;
  if (event === "PreCompact" || (event === undefined && "trigger" in i)) {
    // Not counted here: the compaction may not happen.
    const prev = readRotation(args.files);
    notePendingCompaction(args.files, conversation, i.trigger, args.after);
    const counted =
      prev &&
      (!conversation ||
        !prev.conversation ||
        prev.conversation === conversation)
        ? prev
        : null;
    const next = (counted?.compactions ?? 0) + 1;
    const due =
      dueFor(counted, conversation) ??
      (args.after > 0 && next >= args.after ? "compactions" : undefined);
    if (!due) return "";
    return [
      "Keep this instruction, word for word, at the top of the summary:",
      rotationInstruction(
        args.files,
        due,
        Math.max(next, counted?.compactions ?? 0),
      ),
    ].join("\n");
  }
  if (event === "SessionStart" || (event === undefined && "source" in i)) {
    if (i.source !== "compact" && i.source !== "resume") return "";
    const s =
      i.source === "compact"
        ? noteCompaction(args.files, i, args.after, now)
        : readRotation(args.files);
    const due = dueFor(s, conversation);
    if (!due || readHandoff(args.files).status === "ok") return "";
    return JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: rotationInstruction(args.files, due, s!.compactions),
      },
    });
  }
  return "";
}

async function main(): Promise<void> {
  const args = parseHookArgs(process.argv.slice(2));
  let text = "";
  for await (const chunk of process.stdin) text += String(chunk);
  if (!args) return;
  let out = "";
  try {
    out = rotationHookOutput(JSON.parse(text), args);
  } catch {
    out = "";
  }
  if (out) process.stdout.write(`${out}\n`);
}

if (process.argv[1] && /rotation-hook\.[jt]s$/.test(process.argv[1]))
  main().then(
    () => process.exit(0),
    () => process.exit(0),
  );
