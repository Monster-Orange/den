/**
 * Issue 936: a write the agent sandbox refused, said plainly to the agent.
 * Claude Code runs this after each tool (PostToolUse) and after a failed
 * one (PostToolUseFailure). Inside the sandbox (DEN_AGENT_SANDBOX=1), a
 * refused write ("Operation not permitted", EPERM, "Read-only file
 * system") gets one note for the agent: why, and what to use instead.
 * Anything else, and anything outside the sandbox: nothing. It reads no
 * file and calls nothing: a short-lived hook that can't fail a tool.
 */

const REFUSED = /operation not permitted|\bEPERM\b|read-only file system/i;

/** What the agent is told, beside the tool's own error. */
export const REFUSAL_NOTE =
  "Den's agent sandbox refused that write: Den's state is read-only to an agent's session (issue 936), and so are the install's config/local and its own launch files. Don't retry it or work around it. Ask Den instead: its MCP tools (status, agent_create, gate_slot_request, …) and their held writes for a change, which the person allows. Your own folder (handoff.md, notes) stays writable.";

interface HookInput {
  hook_event_name?: unknown;
  tool_response?: unknown;
  error?: unknown;
}

type Note = {
  hookSpecificOutput: {
    hookEventName: "PostToolUse" | "PostToolUseFailure";
    additionalContext: string;
  };
};

/** The note for this hook input, or null. */
export function refusalNote(
  input: HookInput,
  env: NodeJS.ProcessEnv,
): Note | null {
  if (env.DEN_AGENT_SANDBOX !== "1") return null;
  const ev = input.hook_event_name;
  if (ev !== "PostToolUse" && ev !== "PostToolUseFailure") return null;
  const said = ev === "PostToolUse" ? input.tool_response : input.error;
  let text = "";
  try {
    text = typeof said === "string" ? said : JSON.stringify(said ?? "");
  } catch {
    return null;
  }
  if (!REFUSED.test(text)) return null;
  return {
    hookSpecificOutput: { hookEventName: ev, additionalContext: REFUSAL_NOTE },
  };
}

async function main(): Promise<void> {
  let text = "";
  for await (const chunk of process.stdin) text += String(chunk);
  let input: HookInput;
  try {
    input = JSON.parse(text) as HookInput;
  } catch {
    return;
  }
  const note = refusalNote(input, process.env);
  if (note) process.stdout.write(JSON.stringify(note));
}

if (process.argv[1] && /sandbox-refusal\.[jt]s$/.test(process.argv[1]))
  main().then(
    () => process.exit(0),
    () => process.exit(0),
  );
