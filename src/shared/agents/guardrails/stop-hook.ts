/**
 * Den's Stop hook for Claude Code sessions it launches (den-claude): the
 * hand-back check (handback.ts) on the turn's last message.
 *
 * Hook contract (https://code.claude.com/docs/en/hooks, "Stop input" and
 * "Stop decision control"): JSON on stdin with `last_assistant_message`
 * and `stop_hook_active`. Printing `{"decision":"block","reason":…}` keeps
 * Claude going with the reason; printing nothing lets it stop.
 *
 * A message with the "Hand-back" heading (the template's) gets the whole
 * hand-back check. Any other last message is still what the person reads,
 * so it gets the plain-writing part only: every ID explained (R12).
 * When Claude is already continuing because of a stop hook
 * (stop_hook_active), it lets the turn end, so it never loops. Any error
 * lets the turn end too.
 */
import { bareIds, checkHandback, looksLikeHandback } from "../handback.js";

/** The hook's stdout for one Stop input ("" lets the turn end). */
export function stopDecision(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const i = input as {
    stop_hook_active?: unknown;
    last_assistant_message?: unknown;
  };
  if (i.stop_hook_active === true) return "";
  const msg = i.last_assistant_message;
  if (typeof msg !== "string") return "";
  // A hand-back is checked whole. Any other final message is what the
  // person reads too, so it gets the plain-writing check: no bare IDs.
  const handback = looksLikeHandback(msg);
  const problems = handback
    ? checkHandback(msg).problems
    : bareIds(msg).map(
        (id) =>
          `"${id}" is not explained. Say what it is, e.g. "${id} (what it is)".`,
      );
  if (problems.length === 0) return "";
  return JSON.stringify({
    decision: "block",
    reason: [
      handback
        ? "Den checked your hand-back and it is not ready. Fix these, then send it again:"
        : "Den checked your message to the person and it is not plain yet. Fix these, then send it again:",
      ...problems.map((p) => `- ${p}`),
    ].join("\n"),
  });
}

async function main(): Promise<void> {
  let text = "";
  for await (const chunk of process.stdin) text += String(chunk);
  let out = "";
  try {
    out = stopDecision(JSON.parse(text));
  } catch {
    out = "";
  }
  if (out) process.stdout.write(`${out}\n`);
}

if (process.argv[1] && /stop-hook\.[jt]s$/.test(process.argv[1]))
  main().then(
    () => process.exit(0),
    () => process.exit(0),
  );
