/**
 * Issue 772: one agent prompts another and waits for it, through MCP.
 *
 *   agent_prompt {agent, text}  a held write (the approval policy says
 *                               whether the person's Allow is needed): Den
 *                               types `text` into the target's terminal once
 *   agent_wait {agent, until}   read-only: the MCP tool polls the target's
 *                               state (GET /api/agents/prompt-state)
 *
 * Rules (from herdr's `agent prompt --wait` / `agent wait --until`):
 *   - a Blocked target (it needs its person) is never prompted:
 *     agent_blocked. Its dialog is its person's to answer, never an agent's;
 *   - after the prompt it must be Working or Blocked within 5 s, else
 *     agent_prompt_stalled. Nothing is ever typed twice;
 *   - never itself, and never back into an agent that is waiting on the
 *     caller, directly or down a chain (no loops);
 *   - the target is in the caller's project (Den's own agent: any);
 *   - the agent that prompted (the parent) gets one note when its child
 *     becomes Blocked or ends.
 *
 * In memory: a restart forgets the waits and the parents (nothing is
 * resent; a parent still polls with agent_wait).
 */
import {
  line as rl,
  reviewLines as review,
} from "../../shared/review-lines.js";
import { isServerScope } from "../../shared/agents/server-agent.js";
import { checkInstruction } from "../cli/agent-ops.js";
import { agentSeenSubject } from "../../shared/seen-mark.js";
import type { HeldAsker } from "./approval-routes.js";
import type { HeldOpCheck } from "../cli/agent-ops.js";

type HeldCheck = HeldOpCheck<Record<string, unknown>>;

/** An agent's state as agent_wait names it ("needs" is Blocked). */
export type PromptState = "needs" | "working" | "done" | "idle";

export interface AgentPromptDeps {
  /** The agent's record, or null (no such agent). */
  record(
    id: string,
  ): { id: string; workspace: string; displayName?: string } | null;
  /** Its state as `viewer` sees it, or null when it isn't running. */
  stateOf(id: string, viewer?: string): PromptState | null;
  /** Type `text` into its terminal and press Enter (agent-say typeMessage). */
  type(id: string, text: string): Promise<void>;
  /** One note to an agent (typed after its turn; kept if it is stopped). */
  note(to: { agent: string; project: string }, text: string): void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * An agent's state from what the server holds now: its record (stopped:
 * not running, null), the attention checks' waits and turns, and the seen
 * marks (Done: work `viewer` hasn't seen). The same rule as agentStateOf
 * (agent-state.ts) and the kit's attentionState: a need first, then a
 * turn under way, then unseen work.
 */
export function promptStateOf(o: {
  rec: { id: string; stoppedAt?: string } | null;
  waiting: ReadonlyMap<string, string>;
  working: ReadonlyMap<string, number>;
  seen: {
    latest(subject: string): unknown;
    isSeen(m: { subject: string; person: string }): boolean;
  };
  viewer: string;
}): PromptState | null {
  if (!o.rec || o.rec.stoppedAt) return null;
  const id = o.rec.id;
  const why = o.waiting.get(id);
  if (why && why !== "input") return "needs";
  if (o.working.has(id)) return "working";
  const subject = agentSeenSubject(id);
  if (o.seen.latest(subject) && !o.seen.isSeen({ subject, person: o.viewer }))
    return "done";
  return "idle";
}

/** How long a prompted agent has to start (or ask its person). */
export const STALL_MS = 5000;
/** How often the state is read while waiting for that. */
const POLL_MS = 250;
/** A wait counts while its waiter asked about it this recently. */
export const WAIT_TTL_MS = 30_000;

interface Link {
  parent: string;
  project: string;
}

export class AgentPrompts {
  /** waiter → the agent it waits on, until when. */
  private readonly waits = new Map<string, { target: string; until: number }>();
  /** child → the agent that prompted it. */
  private readonly parents = new Map<string, Link>();
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly d: AgentPromptDeps) {
    this.now = d.now ?? Date.now;
    this.sleep =
      d.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms).unref?.()));
  }

  /** `waiter` waits on `target` now (each agent_wait poll says so). */
  waiting(waiter: string, target: string): void {
    this.waits.set(waiter, { target, until: this.now() + WAIT_TTL_MS });
  }

  /** The check before the Allow (and again before it runs). */
  check(args: Record<string, unknown>, who?: HeldAsker): HeldCheck {
    const no = (error: string): HeldCheck => ({ ok: false, error });
    const id = typeof args.agent === "string" ? args.agent.trim() : "";
    if (!id) return no("agent is required (the agent's id)");
    let text: string | null;
    try {
      text = checkInstruction(args.text);
    } catch (e) {
      return no((e as Error).message.replace(/^instruction/, "text"));
    }
    if (!text) return no("text is required (what to tell the agent)");
    const rec = this.d.record(id);
    if (!rec) return no(`no agent "${id}"`);
    const caller = who?.agent;
    if (caller && caller === id) return no(`${id} can't prompt itself`);
    if (
      who?.project &&
      !isServerScope(who.project) &&
      who.project !== rec.workspace
    )
      return no(
        `${caller ?? "this agent"} works in project ${who.project}: it can prompt that project's agents only, not ${id} in project ${rec.workspace}`,
      );
    if (caller && this.waitsOn(id, caller))
      return no(
        `${id} is waiting on ${caller}: prompting it would make a loop; nothing was sent`,
      );
    if (this.d.stateOf(id) === "needs")
      return no(
        `agent_blocked: ${id} needs its person (a dialog is theirs to answer); nothing was sent`,
      );
    const shown = rec.displayName ?? id;
    return {
      ok: true,
      summary: `Tell ${shown}: ${oneLine(text)}`,
      params: { agent: shown, text: oneLine(text) },
      ...review([
        rl(`Agent: ${shown}, project ${rec.workspace}`, "ap.det.agent.who", {
          agent: shown,
          project: rec.workspace,
        }),
        ...(caller
          ? [
              rl(`Asked by: ${caller}`, "ap.det.agent_prompt.from", {
                agent: caller,
              }),
            ]
          : []),
        rl(`Text: ${text}`, "ap.det.agent_prompt.text", { text }),
      ]),
      args: {
        agent: id,
        project: rec.workspace,
        text,
        ...(caller ? { from: caller } : {}),
      },
    };
  }

  /** On Allow (or at once, when the policy doesn't hold it). */
  async run(args: Record<string, unknown>): Promise<unknown> {
    const id = String(args.agent);
    const text = String(args.text);
    const parent = typeof args.from === "string" ? args.from : undefined;
    const before = this.d.stateOf(id);
    if (before === null)
      return fail("not_running", `${id} isn't running. Resume it first.`);
    if (before === "needs")
      return fail(
        "agent_blocked",
        `${id} needs its person (a dialog is theirs to answer); nothing was sent`,
      );
    try {
      await this.d.type(id, text);
    } catch (e) {
      const code = (e as { code?: string }).code ?? "not_sent";
      return fail(code, (e as Error).message);
    }
    if (parent) this.parents.set(id, { parent, project: String(args.project) });
    const end = this.now() + STALL_MS;
    for (;;) {
      const s = this.d.stateOf(id);
      if (s === "working" || s === "needs")
        return { ok: true, agent: id, state: s };
      if (this.now() >= end) break;
      await this.sleep(POLL_MS);
    }
    return fail(
      "agent_prompt_stalled",
      `${id} didn't start within ${STALL_MS / 1000} s of the prompt. Nothing was sent again; check it with agent_wait.`,
    );
  }

  /**
   * Each attention check (every 2 s): a child that needs its person or
   * ended gets its parent one note, then is forgotten.
   */
  tick(): void {
    for (const [child, link] of [...this.parents]) {
      let s: PromptState | null;
      try {
        s = this.d.stateOf(child);
      } catch {
        continue;
      }
      const why =
        s === null
          ? `${child} ended (it isn't running now).`
          : s === "needs"
            ? `${child} needs its person: it is waiting on a dialog or a question.`
            : null;
      if (!why) continue;
      this.parents.delete(child);
      try {
        this.d.note(
          { agent: link.parent, project: link.project },
          `Den: the agent you prompted, ${why}`,
        );
      } catch {
        /* best effort: agent_wait still says it */
      }
    }
  }

  /**
   * What agent_wait reads: `id`'s state for the caller. Another project's
   * agent is refused (403), an unknown one is 404. An agent's read says it
   * waits on `id` (the loop rule).
   */
  read(
    id: string,
    who: HeldAsker,
  ):
    | {
        status: 200;
        body: { ok: true; agent: string; state: PromptState | null };
      }
    | { status: 400 | 403 | 404; body: { ok: false; error: string } } {
    if (!id)
      return {
        status: 400,
        body: { ok: false, error: "agent is required (the agent's id)" },
      };
    const rec = this.d.record(id);
    if (!rec)
      return { status: 404, body: { ok: false, error: `no agent "${id}"` } };
    if (
      who.project &&
      !isServerScope(who.project) &&
      who.project !== rec.workspace
    )
      return {
        status: 403,
        body: {
          ok: false,
          error: `${who.agent ?? "this agent"} works in project ${who.project}: it can read that project's agents only`,
        },
      };
    if (who.agent && who.agent !== id) this.waiting(who.agent, id);
    return {
      status: 200,
      body: {
        ok: true,
        agent: id,
        state: this.d.stateOf(id, who.agent ? `agent:${who.agent}` : undefined),
      },
    };
  }

  /** Whether `from` waits on `to`, directly or down a chain of waits. */
  private waitsOn(from: string, to: string): boolean {
    const now = this.now();
    const seen = new Set<string>();
    let at = from;
    while (!seen.has(at)) {
      seen.add(at);
      const w = this.waits.get(at);
      if (!w || w.until < now) return false;
      if (w.target === to) return true;
      at = w.target;
    }
    return false;
  }
}

const fail = (code: string, error: string) => ({ ok: false, code, error });

const oneLine = (t: string) => {
  const s = t.replace(/\s+/g, " ");
  return s.length > 120 ? `${s.slice(0, 119)}…` : s;
};

/** GET /api/agents/prompt-state?agent=<id>: agent_wait's poll. */
export async function handlePromptState(
  req: { method?: string },
  res: {
    writeHead(s: number, h?: Record<string, string>): unknown;
    end(b?: string): void;
  },
  url: URL,
  prompts: AgentPrompts,
  who: HeldAsker,
): Promise<void> {
  const send = (status: number, body: unknown) => {
    res.writeHead(status, {
      "content-type": "application/json",
      "cache-control": "no-store",
    });
    res.end(JSON.stringify(body));
  };
  if ((req.method ?? "GET") !== "GET")
    return send(405, { ok: false, error: "GET only" });
  const r = prompts.read((url.searchParams.get("agent") ?? "").trim(), who);
  send(r.status, r.body);
}
