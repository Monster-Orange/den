import { actorTokenOf } from "../../actor-token.js";
import {
  HOOK_CALL_DEFAULT,
  callDen,
  hookCallOf,
  type HookCall,
} from "./hook-call.js";

export const SUBAGENT_TOOLS = ["Agent", "Task"];
export const SUBAGENT_START_ROUTE = "/api/agents/self/subagent-start";
const MESSAGE_MAX = 500;

type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

function plain(text: unknown): string {
  const s = typeof text === "string" ? text : "";
  const clean = s.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ").trim();
  return (clean || "Den refused this subagent.").slice(0, MESSAGE_MAX);
}

export async function subagentDecision(
  base: string,
  input: unknown,
  opts: {
    env?: Record<string, string | undefined>;
    fetch?: FetchFn;
    call?: HookCall;
    onMiss?: (reason: string) => void;
  } = {},
): Promise<{ block: string } | null> {
  const tool =
    input && typeof input === "object"
      ? (input as { tool_name?: unknown }).tool_name
      : undefined;
  if (typeof tool !== "string" || !SUBAGENT_TOOLS.includes(tool)) return null;
  const t = actorTokenOf(opts.env ?? process.env);
  if (!t || !/^[\x21-\x7e]+$/.test(t)) return null;
  const r = await callDen(
    `${base.replace(/\/+$/, "")}${SUBAGENT_START_ROUTE}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${t}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: "{}",
      redirect: "error",
    },
    opts.call ?? HOOK_CALL_DEFAULT,
    { fetch: opts.fetch, onMiss: opts.onMiss },
  );
  if (!r) return null;
  if (r.status !== 409) {
    if (!r.ok) opts.onMiss?.(`refused (HTTP ${r.status})`);
    return null;
  }
  let body: unknown;
  try {
    body = await r.json();
  } catch {
    body = null;
  }
  return {
    block: plain(
      body && typeof body === "object"
        ? (body as { message?: unknown }).message
        : undefined,
    ),
  };
}

async function main(): Promise<number> {
  let text = "";
  for await (const chunk of process.stdin) text += String(chunk);
  const argv = process.argv.slice(2);
  const at = argv.indexOf("--den");
  const base = at >= 0 ? (argv[at + 1] ?? "") : "";
  if (!base) return 0;
  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch {
    return 0;
  }
  let why = "";
  const d = await subagentDecision(base, input, {
    call: hookCallOf(argv),
    onMiss: (r) => (why = r),
  });
  if (d) {
    process.stderr.write(`${d.block}\n`);
    return 2;
  }
  if (why)
    process.stderr.write(
      `Den's subagent limit wasn't checked (${why}); the subagent starts.\n`,
    );
  return 0;
}

if (process.argv[1] && /subagent-hook\.[jt]s$/.test(process.argv[1]))
  main().then(
    (code) => process.exit(code),
    () => process.exit(0),
  );
