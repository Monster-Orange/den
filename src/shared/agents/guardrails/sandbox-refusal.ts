/**
 * Issue 936: a write the agent sandbox refused, said plainly to the agent.
 * Claude Code runs this after each tool (PostToolUse) and after a failed
 * one (PostToolUseFailure). Inside the sandbox (DEN_AGENT_SANDBOX=1), a
 * refused write ("Operation not permitted", EPERM, "Read-only file
 * system") gets one note for the agent: why, and what to use instead. A
 * commit whose GPG signing was refused (gpg's "IPC connect call failed",
 * issue 1316) gets its own, and so does a unix socket the sandbox refused
 * to connect to (issue 1325), a setuid program that couldn't start and
 * Docker's socket (issue 1326). A file tool that succeeded gets nothing:
 * its content may name an error (issue 1326).
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

/**
 * Issue 1326: the setuid programs agents reach for. macOS starts none
 * inside a sandbox. Only these names: the shell's words for a program it
 * couldn't start are the same as for a file it couldn't write ("sh:
 * <path>: Operation not permitted"), and a refused write keeps the state
 * note.
 */
const SETUID = new Set([
  "ps",
  "top",
  "sudo",
  "su",
  "login",
  "passwd",
  "crontab",
  "at",
  "atq",
  "atrm",
  "batch",
  "newgrp",
  "chsh",
  "chfn",
  "chpass",
  "traceroute",
  "traceroute6",
  "mount",
  "umount",
  "quota",
  "wall",
  "write",
]);

/**
 * Issue 1326: a program the shell couldn't start (zsh: "operation not
 * permitted: ps"; bash: "bash: /bin/ps: Operation not permitted"): its
 * name, when it is a setuid one.
 */
function setuidRefused(text: string): string | undefined {
  const re =
    /operation not permitted: (?:\S*\/)?([\w.+-]+)\s*$|\b(?:ba|z)?sh: (?:line \d+: )?(?:\S*\/)?([\w.+-]+): operation not permitted\s*$/gim;
  for (const m of text.matchAll(re)) {
    const prog = m[1] ?? m[2];
    if (prog && SETUID.has(prog)) return prog;
  }
  return undefined;
}

/** Issue 1326: Docker's own words for its socket refused. */
const DOCKER_REFUSED =
  /permission denied while trying to connect to the docker (?:API|daemon)/i;

/** What the agent is told when a setuid program (`prog`) couldn't start. */
export function setuidRefusalNote(prog: string): string {
  if (prog === "sudo" || prog === "su")
    return `Den's agent sandbox can't start \`${prog}\`: it runs as root (setuid), and an agent never does. That is on purpose (issue 1326). Don't retry it or work around it. If the work needs root, tell your person what to run and why.`;
  return `Den's agent sandbox can't start \`${prog}\`: it is a setuid program, and none starts inside the sandbox (issue 1326). This is the sandbox, not the machine. Use \`pgrep\`/\`pkill\` for your own processes (\`pgrep -fl <name>\`), or Den's status tools for its services and agents. Don't retry it or work around it.`;
}

/** What the agent is told when Docker's socket was refused. */
export const DOCKER_REFUSAL_NOTE =
  "Den's agent sandbox refused Docker's socket: outside daemons' sockets are refused, since reaching Docker's is full control of the machine (issue 1326). This is the sandbox, not the machine. Don't retry it or work around it (no other socket path or DOCKER_HOST). If this agent's work needs Docker, tell your person: they can turn this agent's sandbox off.";

/** File tools: a success of theirs is never a refusal (issue 1326). */
const FILE_TOOLS = new Set([
  "Write",
  "Edit",
  "MultiEdit",
  "Read",
  "NotebookEdit",
]);

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
  // A file tool that succeeded: its content may name an error, but nothing
  // was refused (a refused write fails: PostToolUseFailure).
  if (
    ev === "PostToolUse" &&
    typeof input.tool_name === "string" &&
    FILE_TOOLS.has(input.tool_name)
  )
    return null;
  const said = ev === "PostToolUse" ? input.tool_response : input.error;
  let text = "";
  try {
    text = typeof said === "string" ? said : JSON.stringify(said ?? "");
  } catch {
    return null;
  }
  // JSON.stringify keeps a string's line breaks as "\n": read them back.
  const lines = text.replace(/\\n/g, "\n");
  const setuid = setuidRefused(lines);
  const note = GPG_REFUSED.test(text)
    ? GPG_REFUSAL_NOTE
    : DOCKER_REFUSED.test(text)
      ? DOCKER_REFUSAL_NOTE
      : setuid
        ? setuidRefusalNote(setuid)
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
