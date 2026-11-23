/**
 * Issue 936: a write the agent sandbox refused, said plainly to the agent.
 * Claude Code runs this after each tool (PostToolUse) and after a failed
 * one (PostToolUseFailure). Inside the sandbox (DEN_AGENT_SANDBOX=1), a
 * refused write ("Operation not permitted", EPERM, "Read-only file
 * system") gets one note for the agent: why, and what to use instead. A
 * commit whose GPG signing was refused (gpg's "IPC connect call failed",
 * issue 1316) gets its own, and so does a unix socket the sandbox refused
 * to connect to (issue 1325).
 * Anything else, and anything outside the sandbox: nothing. It reads no
 * file and calls nothing: a short-lived hook that can't fail a tool.
 */

const REFUSED = /operation not permitted|\bEPERM\b|read-only file system/i;
/**
 * Issue 1316: gpg can't reach the person's gpg-agent (its socket is
 * refused), so a commit the person's git asks gpg to sign fails.
 */
const GPG_REFUSED =
  /gpg: (?:can't connect to the agent|signing failed)|IPC connect call failed|IPC connect failed|failed to sign the data/i;

/**
 * Issue 1325: a unix socket connection refused ("connect EPERM <path>"),
 * outside Den's own session host (that one is Den's state: REFUSAL_NOTE).
 */
const SOCKET_REFUSED =
  /\bconnect\b[^\n]{0,20}(?:EPERM|EACCES|operation not permitted)/i;
const DEN_HOST_SOCKET = /sessions\.sock\b/;

/** What the agent is told when a unix socket connection was refused. */
export function socketRefusalNote(env: NodeJS.ProcessEnv): string {
  const tmp = env.TMPDIR?.trim();
  return `Den's agent sandbox refused a connection to a unix socket outside your own temp folder: other programs' sockets stay out of reach (issue 1325). Make the socket under $TMPDIR${tmp ? ` (${tmp})` : ""}: your own sockets there connect, a test's or a dev tool's included. Don't retry the other path or work around it.`;
}

/** What the agent is told when a commit's GPG signing was refused. */
export const GPG_REFUSAL_NOTE =
  "Den's agent sandbox keeps the person's GPG agent out of reach, so their GPG key can't sign your commit (issue 1316). Don't retry it, don't turn signing off, and never commit through the GitHub API with the person's token instead. Den signs agents' commits with the agents' own SSH key when the person's git signs commits: if yours aren't signed, the person restarts you from Den (agents.git.signing may be off in user.yml). Tell the person.";

/** What the agent is told, beside the tool's own error. */
export const REFUSAL_NOTE =
  "Den's agent sandbox refused that write: Den's state is read-only to an agent (issue 936), and so are the install's config/local and its own launch files. Don't retry it or work around it. Ask Den instead: its MCP tools (status, agent_create, gate_slot_request, …) and their held writes for a change, which the person allows. Your own folder (handoff.md, notes) stays writable.";

interface HookInput {
  hook_event_name?: unknown;
  tool_name?: unknown;
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
  const note = GPG_REFUSED.test(text)
    ? GPG_REFUSAL_NOTE
    : SOCKET_REFUSED.test(text) && !DEN_HOST_SOCKET.test(text)
      ? socketRefusalNote(env)
      : REFUSED.test(text)
        ? REFUSAL_NOTE
        : null;
  if (!note) return null;
  return {
    hookSpecificOutput: { hookEventName: ev, additionalContext: note },
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
