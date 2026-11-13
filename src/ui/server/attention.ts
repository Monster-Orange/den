/**
 * NT-1 / NT-2 / NT-3b: which agents need their person, from the attention
 * hooks, ask_human and the terminal bell, and the notifications that
 * follow.
 *
 * - waiting (a permission prompt, or waiting for input): the agent is
 *   marked waiting (every list shows it) and a "waiting" notification is
 *   kept, unless its person is looking at it now (NT-2).
 * - finished (its turn ended): a "finished" notification, unless looked
 *   at; any waiting mark goes.
 * - The mark clears itself when the agent's output moves again (it was
 *   answered, or it went on): check(), on a tick, compares the output's
 *   mark with the one taken when it started waiting. Its unread waiting
 *   notification is withdrawn with it.
 * Agent state and output come from `deps` (tests use fakes).
 */
import type { NotificationStore } from "../../shared/notifications.js";

export type WaitingWhy = "permission" | "input" | "asked";

export interface AttentionDeps {
  store: NotificationStore;
  /** A short mark of the agent's output now (a hash of its tail), or null. */
  outputMark: (agent: string) => Promise<string | null>;
  /** The agent's display name, for the text. */
  nameOf: (agent: string) => string;
  now?: () => number;
  /** NT-2: a page that said it shows an agent counts for this long. */
  lookingMs?: number;
}

interface Waiting {
  why: WaitingWhy;
  text: string;
  at: number;
  mark: string | null;
  workspace: string;
}

export class Attention {
  private readonly waiting = new Map<string, Waiting>();
  /** NT-2: agent → until when a page shows it, visible and focused. */
  private readonly looking = new Map<string, number>();
  private readonly now: () => number;
  /** NT-1: each agent's last bell seen (its session's bellAt). */
  private readonly bellSeen = new Map<string, string>();

  constructor(private readonly d: AttentionDeps) {
    this.now = d.now ?? Date.now;
  }

  /** The agents waiting now, and why (the sessions list, the bell). */
  waitingNow(): Map<string, WaitingWhy> {
    return new Map([...this.waiting].map(([a, w]) => [a, w.why]));
  }

  /** NT-2: a page shows these agents now (visible and focused). */
  lookingAt(agents: readonly string[]): void {
    const until = this.now() + (this.d.lookingMs ?? 10_000);
    for (const a of agents) this.looking.set(a, until);
  }

  private onScreen(agent: string): boolean {
    const u = this.looking.get(agent);
    if (u === undefined) return false;
    if (u > this.now()) return true;
    this.looking.delete(agent);
    return false;
  }

  /** An event from agent `agent` (its token proved it) in `workspace`. */
  async event(
    agent: string,
    workspace: string,
    ev:
      | { event: "waiting"; why: WaitingWhy; text?: string }
      | { event: "finished"; text?: string },
  ): Promise<void> {
    const subject = `agent:${agent}`;
    const scope = `workspace/${workspace}`;
    const name = this.d.nameOf(agent);
    const link = `/agents?ws=${encodeURIComponent(workspace)}&agent=${encodeURIComponent(agent)}`;
    if (ev.event === "finished") {
      this.waiting.delete(agent);
      this.d.store.withdraw(subject);
      if (!this.onScreen(agent))
        this.d.store.add({
          kind: "finished",
          subject,
          scope,
          text: ev.text ? `${name}: ${ev.text}` : `${name} finished its turn`,
          link,
        });
      return;
    }
    const text =
      ev.why === "permission"
        ? `${name} needs your permission`
        : ev.why === "asked"
          ? `${name} asked: ${ev.text ?? ""}`
          : `${name} is waiting for you`;
    this.waiting.set(agent, {
      why: ev.why,
      text,
      at: this.now(),
      mark: await this.d.outputMark(agent),
      workspace,
    });
    if (!this.onScreen(agent))
      this.d.store.add({ kind: "waiting", subject, scope, text, link });
  }

  /**
   * NT-1 (3): the sessions' last bells (a bare BEL, OSC 9, OSC 777). A new
   * one marks its agent waiting for input, unless it already waits (it
   * keeps why). A bell first seen more than 10 s old happened before this
   * server looked: history, not a call.
   */
  async bells(
    list: readonly { agent: string; workspace: string; bellAt: string }[],
  ): Promise<void> {
    for (const b of list) {
      const prev = this.bellSeen.get(b.agent);
      if (prev === b.bellAt) continue;
      this.bellSeen.set(b.agent, b.bellAt);
      if (prev === undefined && this.now() - Date.parse(b.bellAt) > 10_000)
        continue;
      if (this.waiting.has(b.agent)) continue;
      await this.event(b.agent, b.workspace, {
        event: "waiting",
        why: "input",
      });
    }
  }

  /** The agent's output moved since it started waiting: no longer waiting. */
  async check(): Promise<void> {
    for (const [agent, w] of [...this.waiting]) {
      const m = await this.d.outputMark(agent);
      if (m === null || w.mark === null || m === w.mark) continue;
      this.waiting.delete(agent);
      this.d.store.withdraw(`agent:${agent}`);
    }
  }

  /** The agent stopped or was removed: nothing waits on it. */
  gone(agent: string): void {
    this.waiting.delete(agent);
    this.d.store.withdraw(`agent:${agent}`);
  }
}
