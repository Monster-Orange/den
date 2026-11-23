/**
 * Issue 159: bringing a conversation in as a Den agent is one Allow, and
 * Den does every step after it. When the conversation is still open in a
 * terminal (its runtime's own process holds it), Den:
 *
 *   1. asks it for its hand-off (handoverAsk: the Allow's answer says
 *      where to write it, and to end the turn);
 *   2. waits for a hand-off that passes the handoff check, and for the
 *      turn to end, or for the terminal to close by itself;
 *   3. closes that terminal (one writer at a time), and brings nothing in
 *      while it is still open;
 *   4. runs the import hook, if the org config sets one
 *      (agents.import.hook): a failing hook is noted, never fatal;
 *   5. continues the conversation as the Den agent, and tells it so.
 *
 * Nothing is ever closed without a hand-off or the terminal's own exit,
 * and every failure reaches the person with its reason (`fail`). The steps
 * are injected: agent-ops.ts wires the real ones.
 */
import { HANDOFF_PARTS } from "./handoff.js";

export interface HandoverSteps {
  /** The pid of the process that holds the conversation, if one does. */
  holder(): number | null;
  /** The conversation is still open in its terminal. */
  stillOpen(): boolean;
  /** Mid-turn (true), between turns (false), or can't tell (null). */
  turnBusy(): boolean | null;
  /** The hand-off file, checked (rotation.ts readHandoff). */
  handoff(): {
    status: "ok" | "missing" | "invalid";
    text?: string;
    problems: string[];
  };
  /** Ask the holder to end (SIGTERM). */
  close(pid: number): void;
  /** The org config's import hook, with the DEN_IMPORT_* variables. */
  runHook(
    env: Record<string, string>,
  ): Promise<{ ok: true } | { ok: false; error: string }>;
  /** Bring it in now: the terminal is closed. */
  importNow(): Promise<{ ok: true; id: string } | { ok: false; error: string }>;
  /** Type `text` into agent `id`'s session. */
  tell(id: string, text: string): Promise<boolean>;
  /** Tell the person the hand-over failed, and why. */
  fail(f: HandoverFailure): void;
  sleep(ms: number): Promise<void>;
  now(): number;
}

export interface HandoverOptions {
  /** The runtime's conversation id. */
  session: string;
  /** The agent id it comes in as. */
  agent: string;
  project: string;
  persona: string;
  /** Where the conversation writes its hand-off (the agent's handoff.md). */
  handoffPath: string;
  /** How long Den waits for the hand-off (agents.import.handoff_wait_minutes). */
  waitMs: number;
  /** How long a closed terminal has to exit. */
  closeWaitMs: number;
  pollMs: number;
  /** The org config's agents.import.hook, if set. */
  hook?: string;
}

/** Why a hand-over stopped: one bell key per case (bell.m.import.<code>). */
export type HandoverFailCode =
  | "noHandoff"
  | "unknownHolder"
  | "wontClose"
  | "importFailed";

export interface HandoverFailure {
  code: HandoverFailCode;
  /** The sentence in English (the bell's text and the audit's). */
  text: string;
  vars: Record<string, string | number>;
}

export type HandoverResult =
  | { ok: true; id: string; notes: string[] }
  | { ok: false; error: string };

/** The Allow's answer to the conversation: where to write its hand-off. */
export function handoverAsk(o: HandoverOptions): string {
  return [
    `The person allowed bringing this conversation into Den as agent ${o.agent} (project ${o.project}, persona ${o.persona}).`,
    `Write your hand-off to ${o.handoffPath}, with these headings, each filled in: ${HANDOFF_PARTS.map((p) => `"## ${p}"`).join(", ")}.`,
    "Then end your turn. Den closes this terminal and continues this same conversation as the Den agent, with Den's tools and signing.",
  ].join("\n");
}

/** The first thing the Den agent is told. */
function broughtInText(o: HandoverOptions): string {
  return [
    `Den brought this conversation in as agent ${o.agent} (project ${o.project}, persona ${o.persona}). Your old terminal is closed.`,
    `Your hand-off is at ${o.handoffPath}. Carry on from its Next step.`,
  ].join("\n");
}

const minutes = (ms: number) => Math.max(1, Math.round(ms / 60_000));

/** Steps 2 to 5 (step 1 is the Allow's answer). Never throws. */
export async function handOver(
  o: HandoverOptions,
  s: HandoverSteps,
): Promise<HandoverResult> {
  const vars = { session: o.session, agent: o.agent, file: o.handoffPath };
  const failed = (
    code: HandoverFailCode,
    error: string,
    more: Record<string, string | number> = {},
  ): HandoverResult => {
    try {
      s.fail({ code, text: error, vars: { ...vars, ...more } });
    } catch {
      /* the result still says why */
    }
    return { ok: false, error };
  };
  try {
    const pid = s.holder();
    // 2. The hand-off and the turn's end, or the terminal's own exit.
    const until = s.now() + o.waitMs;
    for (;;) {
      if (!s.stillOpen()) break;
      if (s.handoff().status === "ok" && s.turnBusy() === false) break;
      if (s.now() >= until)
        return failed(
          "noHandoff",
          `Bringing in conversation ${o.session} as agent ${o.agent} stopped: no hand-off came in ${minutes(o.waitMs)} min, so nothing was closed. It is still open in its terminal. Ask it to write ${o.handoffPath}, then allow the import again.`,
          { minutes: minutes(o.waitMs) },
        );
      await s.sleep(o.pollMs);
    }
    // 3. One writer at a time: close the terminal, and wait for it.
    if (s.stillOpen()) {
      if (pid === null)
        return failed(
          "unknownHolder",
          `Bringing in conversation ${o.session} as agent ${o.agent} stopped: it is still open, and Den can't tell which terminal holds it. Close it there, then allow the import again.`,
        );
      s.close(pid);
      const by = s.now() + o.closeWaitMs;
      while (s.stillOpen()) {
        if (s.now() >= by)
          return failed(
            "wontClose",
            `Bringing in conversation ${o.session} as agent ${o.agent} stopped: its terminal (pid ${pid}) didn't close, so nothing was brought in. Close it there, then allow the import again.`,
            { pid },
          );
        await s.sleep(Math.min(o.pollMs, 500));
      }
    }
    // 4. The hook (for example, a terminal-restore tool's forget).
    const notes: string[] = [];
    if (o.hook) {
      const h = await s.runHook({
        DEN_IMPORT_SESSION: o.session,
        DEN_IMPORT_AGENT: o.agent,
        DEN_IMPORT_PROJECT: o.project,
        ...(pid !== null ? { DEN_IMPORT_PID: String(pid) } : {}),
      });
      if (!h.ok) notes.push(`The import hook failed (${h.error}).`);
    }
    // 5. Continue it here, and say so.
    const r = await s.importNow();
    if (!r.ok)
      return failed(
        "importFailed",
        `Bringing in conversation ${o.session} as agent ${o.agent} failed after its terminal closed: ${r.error}`,
        { reason: r.error },
      );
    // Best effort, and never waited on: the agent is in either way.
    void s
      .tell(r.id, broughtInText({ ...o, agent: r.id }))
      .catch(() => undefined);
    return { ok: true, id: r.id, notes };
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return failed(
      "importFailed",
      `Bringing in conversation ${o.session} as agent ${o.agent} failed: ${reason}`,
      { reason },
    );
  }
}
