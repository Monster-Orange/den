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
 * - The mark clears when the agent goes on. For a runtime with hooks
 *   (Claude Code), its hooks say so: a tool ran, a new prompt, its turn
 *   ended ("resumed" / "finished"); its output is ignored, as it redraws
 *   a prompt while it waits (the 0.4.41 gate). For one without, the
 *   output moving again (check(), on a tick) after it settled: output in
 *   the first SETTLE_MS (the agent drawing its own call) only moves the
 *   mark. Its unread waiting notification is withdrawn with it.
 * Texts are kept in English and as a key with values (`msg`), for the
 * page to say in its own language.
 * Agent state and output come from `deps` (tests use fakes).
 */
import type { NoteMsg, NotificationStore } from "../../shared/notifications.js";

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
  /** Whether the agent's runtime has Den's attention hooks (Claude Code). */
  hooked?: (agent: string) => boolean;
}

/** Output in this long after the event is the agent drawing it, not going on. */
export const SETTLE_MS = 4000;
/**
 * A "resumed" this soon after the wait began is from before it (a tool
 * run in parallel with the one asking): it doesn't clear it.
 */
export const RESUME_AFTER_MS = 1000;

interface Waiting {
  why: WaitingWhy;
  text: string;
  at: number;
  mark: string | null;
  workspace: string;
  /** Cleared by the runtime's hooks, not by its output. */
  byHook: boolean;
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
      | { event: "waiting"; why: WaitingWhy; text?: string; hooked?: boolean }
      | { event: "finished"; text?: string }
      | { event: "resumed"; from: "tool" | "prompt" },
  ): Promise<void> {
    const subject = `agent:${agent}`;
    const scope = `workspace/${workspace}`;
    const name = this.d.nameOf(agent);
    const link = `/agents?project=${encodeURIComponent(workspace)}&agent=${encodeURIComponent(agent)}`;
    if (ev.event === "resumed") {
      const w = this.waiting.get(agent);
      if (!w || this.now() - w.at < RESUME_AFTER_MS) return;
      // An ask is answered by a prompt (the person's reply), not by the
      // ask_human call itself finishing.
      if (w.why === "asked" && ev.from !== "prompt") return;
      this.clear(agent);
      return;
    }
    if (ev.event === "finished") {
      // Asked, then ended its turn to wait for the answer: still waiting.
      if (this.waiting.get(agent)?.why === "asked") return;
      this.clear(agent);
      if (!this.onScreen(agent))
        this.d.store.add({
          kind: "finished",
          subject,
          scope,
          text: ev.text ? `${name}: ${ev.text}` : `${name} finished its turn`,
          msg: ev.text
            ? { key: "bell.m.said", vars: { name, text: ev.text } }
            : { key: "bell.m.turn", vars: { name } },
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
    const msg: NoteMsg =
      ev.why === "permission"
        ? { key: "bell.m.permission", vars: { name } }
        : ev.why === "asked"
          ? { key: "bell.m.asked", vars: { name, text: ev.text ?? "" } }
          : { key: "bell.m.input", vars: { name } };
    const prev = this.waiting.get(agent);
    // Claude Code's idle "waiting for your input" while an ask is open:
    // still the ask.
    if (prev?.why === "asked" && ev.why === "input") return;
    this.waiting.set(agent, {
      why: ev.why,
      text,
      // A second call while waiting (Notification after PermissionRequest)
      // keeps when it began.
      at: prev?.at ?? this.now(),
      mark: await this.d.outputMark(agent),
      workspace,
      byHook:
        ev.hooked === true || prev?.byHook === true || !!this.d.hooked?.(agent),
    });
    if (!this.onScreen(agent))
      this.d.store.add({ kind: "waiting", subject, scope, text, msg, link });
  }

  /** Its person typed into its terminal: answered, whatever it waited on. */
  typed(agent: string): void {
    if (this.waiting.has(agent)) this.clear(agent);
  }

  private clear(agent: string): void {
    this.waiting.delete(agent);
    this.d.store.withdraw(`agent:${agent}`);
  }

  /**
   * 0.4.40 delivery: the agent finished Hub comments (done, not failed).
   * One "finished" item, linking to the comment in Hub when known; none
   * while its person looks at it. The artifact's title is Hub's, and the
   * store makes it plain text.
   */
  hubFinished(
    agent: string,
    workspace: string,
    w: { count: number; artifact?: string; url?: string },
  ): void {
    if (this.onScreen(agent)) return;
    const name = this.d.nameOf(agent);
    const what = w.count === 1 ? "1 Hub comment" : `${w.count} Hub comments`;
    const vars = { name, n: w.count, artifact: w.artifact ?? "" };
    // Bell v6: Hub's comments are the "Replies and comments in Hub" kind
    // (it was "finished", so turning finished off hid them).
    this.d.store.add({
      kind: "answer",
      subject: `agent:${agent}`,
      scope: `workspace/${workspace}`,
      text: `${name} finished ${what}${w.artifact ? ` on ${w.artifact}` : ""}`,
      msg: { key: w.artifact ? "bell.m.hubOn" : "bell.m.hub", vars },
      link:
        w.url && /^https?:\/\//.test(w.url)
          ? w.url
          : `/agents?project=${encodeURIComponent(workspace)}&agent=${encodeURIComponent(agent)}`,
    });
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

  /**
   * An agent without hooks whose output moved since it settled: no longer
   * waiting. In its first SETTLE_MS, output only moves the mark.
   */
  async check(): Promise<void> {
    for (const [agent, w] of [...this.waiting]) {
      if (w.byHook) continue;
      const m = await this.d.outputMark(agent);
      if (m === null || m === w.mark) continue;
      if (w.mark === null || this.now() - w.at < SETTLE_MS) {
        w.mark = m;
        continue;
      }
      this.clear(agent);
    }
  }

  /** The agent stopped or was removed: nothing waits on it. */
  gone(agent: string): void {
    this.clear(agent);
  }
}
