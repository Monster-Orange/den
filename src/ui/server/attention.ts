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
 * - Issue 327: a wait never outlives its dialog. A new Claude session
 *   ("resumed" from "session": a restart, a resume, a clear) and Claude
 *   Code's idle notice (no dialog is open) clear a permission wait too.
 *   Each wait keeps what it saw (the tool, or the notice, trimmed) and
 *   since when; the bell row and the update check say both.
 * Texts are kept in English and as a key with values (`msg`), for the
 * page to say in its own language.
 * Agent state and output come from `deps` (tests use fakes).
 */
import type { NoteMsg, NotificationStore } from "../../shared/notifications.js";
import { trimWhat } from "../../shared/agents/guardrails/attention-hook.js";
import { leadAskText } from "./lead-routing.js";

export type WaitingWhy = "permission" | "input" | "asked";

/**
 * The agents Den won't type into (a Hub delivery, a tools note): a held
 * Allow (`approvalActors`, "agent:<id>"), a permission prompt, or an
 * ask_human question; typed text would answer them. An idle agent
 * ("input": Claude Code's notice after a turn) takes them. Issue 278:
 * `paused`, agents held after a compaction loop until a person clears it.
 */
export function typingHeld(
  why: ReadonlyMap<string, string>,
  approvalActors: Iterable<string>,
  paused: Iterable<string> = [],
): Set<string> {
  const out = new Set<string>(paused);
  for (const [agent, w] of why) if (w !== "input") out.add(agent);
  for (const actor of approvalActors)
    if (actor.startsWith("agent:")) out.add(actor.slice("agent:".length));
  return out;
}

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
  /**
   * #142: the question the agent's finished turn ended on, or null. A turn
   * that ends asking its person something needs them, as ask_human does.
   */
  endedAsking?: (agent: string) => Promise<string | null>;
  /**
   * Issue 327: of these waiting agents, the ones that ended: "stopped"
   * (stopped or removed) or "exited" (its session ended by itself). An
   * agent missing from the answer runs on, or Den can't tell.
   */
  ended?: (
    agents: readonly string[],
  ) => Promise<ReadonlyMap<string, "stopped" | "exited">>;
  /**
   * Issue 101: the lead of `agent`'s project for its question, or null
   * (lead-routing.ts pickLead).
   */
  leadOf?: (agent: string, workspace: string) => Promise<string | null>;
  /** Issue 101: type `text` to agent `lead`; false when Den couldn't. */
  tellLead?: (lead: string, text: string) => Promise<boolean>;
}

/** Output in this long after the event is the agent drawing it, not going on. */
export const SETTLE_MS = 4000;
/**
 * A "resumed" this soon after the wait began is from before it (a tool
 * run in parallel with the one asking): it doesn't clear it.
 */
export const RESUME_AFTER_MS = 1000;

/** Issue 327: what an agent waits on, and since when (ISO). */
export interface WaitingDetail {
  why: WaitingWhy;
  what: string;
  since: string;
}

interface Waiting {
  why: WaitingWhy;
  text: string;
  /** Issue 327: the tool it asks for, or the notice, trimmed. */
  what: string;
  at: number;
  mark: string | null;
  workspace: string;
  /** Cleared by the runtime's hooks, not by its output. */
  byHook: boolean;
  /** Issue 101: the lead its question went to, instead of its person. */
  lead?: string;
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

  /** An agent's display name (issue 101: the lead a question went to). */
  nameOf(agent: string): string {
    return this.d.nameOf(agent);
  }

  /** The agents waiting now, and why (the sessions list, the bell). */
  waitingNow(): Map<string, WaitingWhy> {
    return new Map([...this.waiting].map(([a, w]) => [a, w.why]));
  }

  /** Issue 327: what `agent` waits on and since when, or undefined. */
  waitingDetail(agent: string): WaitingDetail | undefined {
    const w = this.waiting.get(agent);
    return w
      ? { why: w.why, what: w.what, since: new Date(w.at).toISOString() }
      : undefined;
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
      | {
          event: "waiting";
          why: WaitingWhy;
          text?: string;
          what?: string;
          idle?: boolean;
          hooked?: boolean;
        }
      | { event: "finished"; text?: string }
      | { event: "resumed"; from: "tool" | "prompt" | "session" },
  ): Promise<{ lead: string } | void> {
    const subject = `agent:${agent}`;
    const scope = `workspace/${workspace}`;
    const name = this.d.nameOf(agent);
    const link = `/agents?project=${encodeURIComponent(workspace)}&agent=${encodeURIComponent(agent)}`;
    if (ev.event === "resumed") {
      const w = this.waiting.get(agent);
      if (!w) return;
      // Issue 327: a new session has no dialog from before it; an ask
      // stays (Den holds the question, not the session).
      if (ev.from === "session") {
        if (w.why !== "asked") this.clear(agent);
        return;
      }
      if (this.now() - w.at < RESUME_AFTER_MS) return;
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
      // #142: a turn that ended on a question to its person needs them.
      const q = this.d.endedAsking
        ? await this.d.endedAsking(agent).catch(() => null)
        : null;
      if (q)
        return this.event(agent, workspace, {
          event: "waiting",
          why: "asked",
          text: q,
          hooked: true,
        });
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
    const prev = this.waiting.get(agent);
    // Issue 327: Claude Code's idle notice means no dialog is open: a
    // permission wait from before it is over.
    if (
      ev.idle === true &&
      prev?.why === "permission" &&
      this.now() - prev.at >= RESUME_AFTER_MS
    ) {
      this.clear(agent);
      return;
    }
    // A second call while waiting (Notification after PermissionRequest)
    // keeps when it began and what it named first.
    const what =
      prev?.why === ev.why && prev.what
        ? prev.what
        : trimWhat(ev.what ?? ev.text ?? "");
    const text =
      ev.why === "permission"
        ? what
          ? `${name} needs your permission: ${what}`
          : `${name} needs your permission`
        : ev.why === "asked"
          ? `${name} asked: ${ev.text ?? ""}`
          : `${name} is waiting for you`;
    const msg: NoteMsg =
      ev.why === "permission"
        ? what
          ? { key: "bell.m.permissionWhat", vars: { name, what } }
          : { key: "bell.m.permission", vars: { name } }
        : ev.why === "asked"
          ? { key: "bell.m.asked", vars: { name, text: ev.text ?? "" } }
          : { key: "bell.m.input", vars: { name } };
    // Claude Code's idle "waiting for your input" while an ask is open:
    // still the ask.
    if (prev?.why === "asked" && ev.why === "input") return;
    const hooked =
      ev.hooked === true || prev?.byHook === true || !!this.d.hooked?.(agent);
    // #142: an idle agent isn't waiting on its person. With hooks, its
    // turn's end already said so (finished, in Updates; a question there
    // is "asked"): the idle notice adds nothing.
    if (ev.why === "input" && hooked) return;
    // Issue 101: a question goes to the project's lead, when it has one
    // Den can type to; the same question again isn't told twice.
    const q = ev.text ?? "";
    const lead =
      ev.why !== "asked"
        ? undefined
        : prev?.why === "asked" && prev.lead && prev.text === text
          ? prev.lead
          : await this.toLead(agent, workspace, name, q);
    this.waiting.set(agent, {
      why: ev.why,
      text,
      what,
      at: prev?.at ?? this.now(),
      mark: await this.d.outputMark(agent),
      workspace,
      byHook: hooked,
      ...(lead ? { lead } : {}),
    });
    if (lead) {
      if (prev?.lead !== lead || prev.text !== text)
        this.d.store.add({
          kind: "finished",
          subject,
          scope,
          text: `${name} asked the lead, ${this.d.nameOf(lead)}: ${q}`,
          msg: {
            key: "bell.m.toLead",
            vars: { name, lead: this.d.nameOf(lead), text: q },
          },
          link,
        });
      return { lead };
    }
    // #142: without hooks, a bell is all there is: an update, not a need.
    if (!this.onScreen(agent))
      this.d.store.add({
        kind: ev.why === "input" ? "finished" : "waiting",
        subject,
        scope,
        text,
        msg,
        link,
      });
  }

  /**
   * Issue 101: tell the lead of `agent`'s project its question; the lead,
   * or undefined when there is none, the asker leads, or the lead can't
   * take it now (it waits on its own person, or Den couldn't type).
   */
  private async toLead(
    agent: string,
    workspace: string,
    name: string,
    question: string,
  ): Promise<string | undefined> {
    if (!this.d.leadOf || !this.d.tellLead) return undefined;
    const lead = await this.d.leadOf(agent, workspace).catch(() => null);
    if (!lead || lead === agent) return undefined;
    const busy = this.waiting.get(lead);
    if (busy && busy.why !== "input") return undefined;
    const told = await this.d
      .tellLead(lead, leadAskText(name, agent, question))
      .catch(() => false);
    return told ? lead : undefined;
  }

  /** Its person typed into its terminal: answered, whatever it waited on. */
  typed(agent: string): void {
    if (this.waiting.has(agent)) this.clear(agent);
  }

  private clear(agent: string): void {
    const w = this.waiting.get(agent);
    this.waiting.delete(agent);
    this.d.store.withdraw(`agent:${agent}`);
    // #142: a hookless bell's update ("is waiting for you") goes with it.
    if (w?.why === "input") this.d.store.withdraw(`agent:${agent}`, "finished");
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
    await this.sweepEnded();
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

  /**
   * Issue 327: a wait never outlives its agent. A stopped or removed one
   * (`agents stop` from the CLI too, which the server doesn't see) ends
   * every wait, an ask too: nothing can answer it after. A session that
   * ended by itself ends a dialog; an ask stays (Den holds the question
   * for a resume).
   */
  private async sweepEnded(): Promise<void> {
    if (!this.d.ended || !this.waiting.size) return;
    let ended: ReadonlyMap<string, "stopped" | "exited">;
    try {
      ended = await this.d.ended([...this.waiting.keys()]);
    } catch {
      return;
    }
    for (const [agent, how] of ended) {
      const w = this.waiting.get(agent);
      if (!w) continue;
      if (how === "exited" && w.why === "asked") continue;
      this.clear(agent);
    }
  }
}
