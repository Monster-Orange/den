/**
 * NT-1 / NT-2 / NT-3b: which agents need their person, from the attention
 * hooks, ask_human and the terminal bell, and the notifications that
 * follow.
 *
 * - waiting (a permission prompt, or waiting for input): the agent is
 *   marked waiting (every list shows it) and a "waiting" notification is
 *   kept; it alerts unless its person is looking at it now (NT-2). Issue
 *   142: kept even then, so a page closed within NT-2's window loses
 *   nothing.
 * - finished (its turn ended): a "finished" notification (the page's
 *   next "looking" takes it out if it still shows the agent); any
 *   waiting mark goes. A turn ending on a question is "asked".
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
 * - Issue 369: a waiting row kept across a restart has no wait in memory.
 *   At start and on the checks after it (until each is decided), its
 *   agent stopped, removed or exited, or no dialog on its screen: the row
 *   goes; still showing it: the row stays and is a live wait again.
 * Texts are kept in English and as a key with values (`msg`), for the
 * page to say in its own language.
 * Agent state and output come from `deps` (tests use fakes).
 */
import type {
  NoteMsg,
  Notification,
  NotificationStore,
} from "../../shared/notifications.js";
import { trimWhat } from "../../shared/agents/guardrails/attention-hook.js";
import { leadAskText } from "./lead-routing.js";

export type WaitingWhy = "permission" | "input" | "asked";

/**
 * Issue 369: what a kept waiting row waits on, from its text's key (or,
 * a row from before keys, its English): a permission dialog or an ask.
 * Null: another waiting row (an agent not back after a restart).
 */
export function rowWhy(n: Notification): "permission" | "asked" | null {
  const k = n.msg?.key;
  if (k === "bell.m.permission" || k === "bell.m.permissionWhat")
    return "permission";
  if (k === "bell.m.asked") return "asked";
  if (k) return null;
  if (/ needs your permission(:|$)/.test(n.text)) return "permission";
  if (/ asked: /.test(n.text)) return "asked";
  return null;
}

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

/**
 * Issue 701: the agents Hub deliveries (and relayed messages) wait for:
 * as typingHeld, but an ask_human question doesn't hold them. The agent
 * ended its turn to wait for its person's answer, and the person's
 * comment is that answer. A permission dialog, a held Allow or a pause
 * still holds them; so does a dialog on screen (agentInputState).
 */
export function deliveryHeld(
  why: ReadonlyMap<string, string>,
  approvalActors: Iterable<string>,
  paused: Iterable<string> = [],
): Set<string> {
  const asked = new Map([...why].filter(([, w]) => w !== "asked"));
  return typingHeld(asked, approvalActors, paused);
}

export interface AttentionDeps {
  store: NotificationStore;
  turnEnded?: (agent: string, at: number) => void;
  /**
   * Issue 1129: the agent is working (a tool ran, a prompt came) or idle
   * (its turn ended, it waits for its person), kept so a resume after a
   * restart starts the working ones first. A new session says neither.
   */
  activity?: (agent: string, working: boolean) => void;
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
   * Issue 369: whether the agent's screen shows its permission dialog
   * now: true, false (no dialog, or no session), or null when Den can't
   * tell yet (the session host didn't answer). A runtime whose dialogs
   * Den can't see answers true: its output going on clears it.
   */
  dialogOpen?: (agent: string) => Promise<boolean | null>;
  /**
   * Issue 101: the lead of `agent`'s project for its question, or null
   * (lead-routing.ts pickLead).
   */
  leadOf?: (agent: string, workspace: string) => Promise<string | null>;
  /** Issue 101: type `text` to agent `lead`; false when Den couldn't. */
  tellLead?: (lead: string, text: string) => Promise<boolean>;
  /**
   * Issue 1008: type `text` to `agent` (an answer came after it withdrew
   * its question); false when Den couldn't.
   */
  tell?: (agent: string, text: string) => Promise<boolean>;
  /**
   * Issue 172: an agent began to need its person (a permission prompt or
   * a question), and its person isn't looking at it: alert them outside
   * the bell (alert-feed.ts). Once per wait, never for a repeat.
   */
  alert?: (n: {
    agent: string;
    workspace: string;
    why: "permission" | "asked";
  }) => void;
}

/** Output in this long after the event is the agent drawing it, not going on. */
export const SETTLE_MS = 4000;
/**
 * A "resumed" this soon after the wait began is from before it (a tool
 * run in parallel with the one asking): it doesn't clear it.
 */
export const RESUME_AFTER_MS = 1000;

/**
 * Issue 609: whether a tool run is the one a permission wait asked for:
 * the same tool, and the same input when both say it (an older hook, or
 * a caller that names only the tool, matches on the tool).
 */
export function ownRun(
  w: { why: WaitingWhy; what: string; input?: string },
  run: { what: string; input?: string },
): boolean {
  return (
    w.why === "permission" &&
    !!w.what &&
    w.what === run.what &&
    (!w.input || !run.input || w.input === run.input)
  );
}

/** Issue 327: what an agent waits on, and since when (ISO). */
export interface WaitingDetail {
  why: WaitingWhy;
  what: string;
  since: string;
}

/**
 * Issue 1008: an agent's withdrawn question, until its next question or
 * an answer that came late. `typed`: its person typed into it since.
 */
interface SettledAsk {
  id: string;
  reason: string;
  name: string;
  question: string;
  typed: boolean;
}

/** Issue 1008: the bell's words for a settled question. */
function settledSay(
  how: "agent" | "person" | "late",
  v: { name: string; question: string; reason: string },
): { text: string; msg: NoteMsg } {
  const vars = { name: v.name, text: v.question, reason: v.reason };
  if (how === "late")
    return {
      text: `${v.name}'s question was settled: ${v.reason}; your answer came after it and was passed on (${v.question})`,
      msg: { key: "bell.m.settledLate", vars },
    };
  if (how === "person")
    return {
      text: `You withdrew ${v.name}'s question, settled: ${v.reason} (${v.question})`,
      msg: { key: "bell.m.settledYou", vars },
    };
  return {
    text: `${v.name} withdrew its question, settled: ${v.reason} (${v.question})`,
    msg: { key: "bell.m.settled", vars },
  };
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
  /** Issue 609: the hash of the asked tool's input (attention-hook.ts). */
  input?: string;
  /** Issue 101: the lead its question went to, instead of its person. */
  lead?: string;
  /**
   * An ask its turn's end said (a hand-back's decision), not ask_human:
   * the agent's next turn ending with no question says it no longer asks.
   */
  turn?: boolean;
  /**
   * Issue 828: a question on the agent's screen (AskUserQuestion, an
   * elicitation): its answer (a tool run, a prompt) or its turn's end
   * ends it; never sent to the lead.
   */
  dialog?: boolean;
}

export class Attention {
  private readonly waiting = new Map<string, Waiting>();
  /** Issue 1008: each agent's last withdrawn question. */
  private readonly settledAsks = new Map<string, SettledAsk>();
  /** NT-2: agent → until when a page shows it, visible and focused. */
  private readonly looking = new Map<string, number>();
  private readonly working = new Map<string, number>();
  private readonly now: () => number;
  /** NT-1: each agent's last bell seen (its session's bellAt). */
  private readonly bellSeen = new Map<string, string>();
  /** Issue 369: rows from before this server still to decide. */
  private orphansLeft = true;
  /** Issue 609: events in the order they came (a set's awaits aside). */
  private seq = 0;
  /** Issue 609: each agent's last named tool run, and when it came. */
  private readonly lastRun = new Map<
    string,
    { seq: number; at: number; what: string; input?: string }
  >();

  constructor(private readonly d: AttentionDeps) {
    this.now = d.now ?? Date.now;
  }

  /** An agent's display name (issue 101: the lead a question went to). */
  nameOf(agent: string): string {
    return this.d.nameOf(agent);
  }

  workingNow(): Map<string, number> {
    return new Map(this.working);
  }

  private turnEnd(agent: string): void {
    this.working.delete(agent);
    try {
      this.d.turnEnded?.(agent, this.now());
    } catch {
      /* the seen mark is best effort */
    }
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
          /** Issue 609: the asked tool's input hash. */
          input?: string;
          /** The ask is its turn's last line, not an ask_human call. */
          turn?: boolean;
          /** Issue 828: a question on the agent's screen. */
          dialog?: boolean;
        }
      | { event: "finished"; text?: string; question?: string }
      | {
          event: "resumed";
          from: "tool" | "prompt" | "session";
          /** Issue 609: the tool that ran, and its input hash. */
          what?: string;
          input?: string;
        },
  ): Promise<{ lead: string; askId?: string } | void> {
    const subject = `agent:${agent}`;
    const scope = `workspace/${workspace}`;
    const name = this.d.nameOf(agent);
    const link = `/agents?project=${encodeURIComponent(workspace)}&agent=${encodeURIComponent(agent)}`;
    const seq = ++this.seq;
    try {
      if (ev.event !== "resumed") this.d.activity?.(agent, false);
      else if (ev.from !== "session") this.d.activity?.(agent, true);
    } catch {
      /* best effort: only the resume order uses it */
    }
    const arrived = this.now();
    if (ev.event === "resumed") {
      // Issue 609: a named tool run is kept, so a dialog for it applied
      // after it (its set still awaiting, or the calls swapped) doesn't
      // stay up.
      const run =
        ev.from === "tool" && ev.what
          ? { seq, at: arrived, what: ev.what, input: ev.input }
          : undefined;
      if (run) this.lastRun.set(agent, run);
      if (ev.from !== "session" && !this.working.has(agent))
        this.working.set(agent, arrived);
      // Issue 1008: the person's prompt after a withdraw: a late answer.
      if (ev.from === "prompt") await this.lateAnswer(agent);
      const w = this.waiting.get(agent);
      if (!w) return;
      // Issue 609: the asked tool ran (it was allowed): its dialog is
      // over, however soon after it the run came.
      if (run && ownRun(w, run)) {
        this.lastRun.delete(agent);
        this.clear(agent);
        return;
      }
      // Issue 327: a new session has no dialog from before it; an ask
      // stays (Den holds the question, not the session).
      if (ev.from === "session") {
        if (w.why !== "asked" || w.dialog) this.clear(agent);
        return;
      }
      if (this.now() - w.at < RESUME_AFTER_MS) return;
      // An ask is answered by a prompt (the person's reply), not by the
      // ask_human call itself finishing. Issue 828: a question on screen
      // is answered in it, and the agent goes on (a tool runs).
      if (w.why === "asked" && ev.from !== "prompt" && !w.dialog) return;
      this.clear(agent);
      return;
    }
    if (ev.event === "finished") {
      this.working.delete(agent);
      // Asked (ask_human), then ended its turn to wait for the answer:
      // still waiting. A question its last turn ended on is the turn's
      // own: this turn's end says again whether it asks (a hand-back with
      // "Decisions: none" doesn't), so it goes and this end decides.
      const prior = this.waiting.get(agent);
      if (prior?.why === "asked" && !prior.turn && !prior.dialog) return;
      // #142: a turn that ended on a question to its person needs them:
      // the question the hook said (issue 142, Claude Code's last answer),
      // else the one its transcript ends on.
      const q =
        ev.question ||
        (this.d.endedAsking
          ? await this.d.endedAsking(agent).catch(() => null)
          : null);
      // A wait that came while the transcript was read (a delivery typed
      // at this turn's end starts a new turn, which may ask) is newer than
      // this end: it stands, and this older end changes nothing.
      if (this.waiting.get(agent) !== prior) return;
      // The same question again: the same wait (no second row or alert).
      if (prior?.turn && q && prior.text === `${name} asked: ${q}`) return;
      this.clear(agent);
      if (q)
        return this.event(agent, workspace, {
          event: "waiting",
          why: "asked",
          text: q,
          hooked: true,
          turn: true,
        });
      this.turnEnd(agent);
      // Issue 142: kept even while a page shows the agent. That page's
      // next "looking" takes it out (opening an agent clears its updates);
      // a page that closed meanwhile (NT-2 keeps it 10 s) never does, and
      // the turn's end would be lost.
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
    // Issue 828: the permission notice that comes with AskUserQuestion's
    // dialog is that question, not a permission: a permission with no
    // tool input (a Notification), or one naming AskUserQuestion. Another
    // tool's PermissionRequest is its own wait.
    if (
      prev?.why === "asked" &&
      prev.dialog &&
      ev.why === "permission" &&
      (!ev.input || /AskUserQuestion/.test(`${ev.what ?? ""} ${ev.text ?? ""}`))
    )
      return;
    this.working.delete(agent);
    const hookless =
      ev.hooked !== true && prev?.byHook !== true && !this.d.hooked?.(agent);
    if (ev.why === "input" && hookless && !prev) this.turnEnd(agent);
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
          ? {
              key: "bell.m.asked",
              // Kept on the row, so a restart knows a turn's ask (reconcile).
              vars: {
                name,
                text: ev.text ?? "",
                ...(ev.turn ? { turn: 1 } : {}),
                ...(ev.dialog ? { dialog: 1 } : {}),
              },
            }
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
      ev.why !== "asked" || ev.dialog
        ? undefined
        : prev?.why === "asked" && prev.lead && prev.text === text
          ? prev.lead
          : await this.toLead(agent, workspace, name, q);
    const mark = await this.d.outputMark(agent);
    // Issue 609: the asked tool's run already landed (while this set
    // awaited, or just before it: the two calls swapped). The clear wins:
    // no wait is left.
    const ran = this.lastRun.get(agent);
    if (
      ev.why === "permission" &&
      ran &&
      (ran.seq > seq || arrived - ran.at < RESUME_AFTER_MS) &&
      ownRun(
        { why: ev.why, what: trimWhat(ev.what ?? ""), input: ev.input },
        ran,
      )
    ) {
      this.lastRun.delete(agent);
      if (this.waiting.has(agent)) this.clear(agent);
      return;
    }
    const cur = this.waiting.get(agent);
    // Issue 1008: a new question; the withdrawn one is behind it.
    if (ev.why === "asked") this.settledAsks.delete(agent);
    this.waiting.set(agent, {
      why: ev.why,
      text,
      what,
      at: cur?.at ?? this.now(),
      mark,
      workspace,
      byHook: hooked,
      input: what === cur?.what ? (cur?.input ?? ev.input) : ev.input,
      ...(lead ? { lead } : {}),
      ...(ev.why === "asked" && ev.turn ? { turn: true } : {}),
      ...(ev.why === "asked" && ev.dialog ? { dialog: true } : {}),
    });
    if (lead) {
      let row: Notification | null | undefined = null;
      if (prev?.lead !== lead || prev.text !== text)
        row = this.d.store.add({
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
      // Issue 1058: the "asked the lead" row is the question's id.
      row ??= this.d.store
        .list()
        .find(
          (n) =>
            n.subject === subject &&
            !n.settled &&
            n.msg?.key === "bell.m.toLead" &&
            n.msg.vars.text === q,
        );
      return { lead, ...(row ? { askId: row.id } : {}) };
    }
    const looking = this.onScreen(agent);
    // Issue 172: a new need (not the same wait said again) alerts.
    if (
      !looking &&
      (ev.why === "permission" || ev.why === "asked") &&
      prev?.why !== ev.why
    )
      try {
        this.d.alert?.({ agent, workspace, why: ev.why });
      } catch {
        /* an alert is best effort: the bell has it */
      }
    // #142: without hooks, a bell is all there is: an update, not a need.
    // Issue 142: kept even while a page shows the agent (only the alert
    // waits for it to be off screen). A need counts until it is answered;
    // an update goes on that page's next "looking".
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
    const s = this.settledAsks.get(agent);
    if (s) s.typed = true;
    if (this.waiting.has(agent)) this.clear(agent);
  }

  /** Issue 1008: whether any agent has a withdrawn question kept. */
  hasSettled(): boolean {
    return this.settledAsks.size > 0;
  }

  /**
   * Issue 1008: the question in bell row `id` (agent `agent`'s) was
   * settled elsewhere: `by` is `agent:<id>` (the agent that asked) or
   * `person`. Its wait goes; the row stays, read, saying why, who and
   * when. Null when the row isn't there or was settled already.
   */
  settle(
    agent: string,
    id: string,
    s: { reason: string; by: string },
  ): Notification | null {
    const row = this.d.store.list().find((n) => n.id === id);
    if (!row || row.settled) return null;
    const name = this.d.nameOf(agent);
    const v = row.msg?.vars.text;
    const question =
      typeof v === "string" ? v : row.text.replace(/^.*? asked: /, "");
    const out = this.d.store.settle(
      id,
      s,
      settledSay(s.by === "person" ? "person" : "agent", {
        name,
        question,
        reason: s.reason,
      }),
    );
    if (!out) return null;
    const w = this.waiting.get(agent);
    if (w?.why === "asked") this.clear(agent);
    // Issue 1058: a question that went to the lead: the lead is told.
    if (row.msg?.key === "bell.m.toLead" && w?.lead)
      void this.d
        .tellLead?.(
          w.lead,
          `Den: ${name}'s question to you is settled: ${out.settled?.reason ?? s.reason}. It asked: "${question}". Nothing is left to decide.`,
        )
        .catch(() => false);
    this.settledAsks.set(agent, {
      id,
      reason: out.settled?.reason ?? s.reason,
      name,
      question,
      typed: false,
    });
    return out;
  }

  /**
   * Issue 1008: a prompt went in after the agent withdrew its question,
   * and its person had typed into it (a prompt Den types is no answer):
   * the answer came late. Kept (it went in) and the row says so; the
   * agent is told, once.
   */
  private async lateAnswer(agent: string): Promise<void> {
    const s = this.settledAsks.get(agent);
    if (!s?.typed) return;
    this.settledAsks.delete(agent);
    this.d.store.settledLate(
      s.id,
      settledSay("late", {
        name: s.name,
        question: s.question,
        reason: s.reason,
      }),
    );
    await this.d
      .tell?.(
        agent,
        `Den: your person answered after you withdrew your question (settled: ${s.reason}). Their answer is the input you just got; it is kept. Check whether it changes anything.`,
      )
      .catch(() => false);
  }

  /**
   * Issue 701: a comment from the agent's person was typed into it: its
   * question is answered. A dialog (permission) isn't: only its answer on
   * screen ends that.
   */
  answered(agent: string): void {
    // Issue 1008: a comment typed in after a withdraw is a late answer.
    const s = this.settledAsks.get(agent);
    if (s) s.typed = true;
    if (this.waiting.get(agent)?.why === "asked") this.clear(agent);
  }

  /**
   * P0-D2: an approval came for `agent`'s doc or held write (`keys`, from
   * approvalKeys). Its question that names one of them goes, and so does
   * a question of another agent in `workspace` that names one. Returns
   * each agent cleared and the key its question named (Den tells the
   * others, and logs each). A dialog (permission) stays.
   */
  approvedAbout(
    agent: string,
    workspace: string,
    keys: string[],
    version?: number,
  ): { agent: string; key: string }[] {
    const out: { agent: string; key: string }[] = [];
    for (const [a, w] of [...this.waiting]) {
      if (w.why !== "asked") continue;
      if (a !== agent && w.workspace !== workspace) continue;
      const key = keys.find((k) => namesKey(w.text, k));
      if (!key) continue;
      // A question about another version of the doc isn't answered.
      // One version asked and it is this one, or none: answered. Several
      // (v2 or v3?) or another: the person still has to say which.
      const asked = askedVersions(w.text);
      if (
        version !== undefined &&
        asked.size &&
        (asked.size > 1 || !asked.has(version))
      )
        continue;
      this.clear(a);
      out.push({ agent: a, key });
    }
    return out;
  }

  private clear(agent: string): void {
    const w = this.waiting.get(agent);
    this.waiting.delete(agent);
    // The wait's row goes with it, read or not: "Needs you" lists read
    // rows too, so a row the person had opened stayed after its answer.
    const subject = `agent:${agent}`;
    // Issue 1008: a settled question's row is history: it stays.
    this.d.store.remove(
      (n) => n.subject === subject && n.kind === "waiting" && !n.settled,
    );
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
   * Issue 701: Hub comments typed into the agent had no answer after
   * hub.delivery_answer_minutes; its next comments go on. One item,
   * linking to the comment in Hub when known.
   */
  hubNoAnswer(
    agent: string,
    workspace: string,
    w: { count: number; minutes: number; artifact?: string; url?: string },
  ): void {
    const name = this.d.nameOf(agent);
    const what = w.count === 1 ? "1 Hub comment" : `${w.count} Hub comments`;
    this.d.store.add({
      kind: "answer",
      subject: `agent:${agent}`,
      scope: `workspace/${workspace}`,
      text: `${name}: ${what} typed in, no answer yet after ${w.minutes} min`,
      msg: {
        key: "bell.m.hubNoAnswer",
        vars: { name, n: w.count, m: w.minutes },
      },
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
    await this.reconcile();
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

  /**
   * Issue 369: the unread waiting rows (a permission dialog, an ask) with
   * no wait in memory: kept from before this server started. Each is
   * withdrawn or adopted as a live wait; one Den can't decide yet stays
   * for the next check. Other waiting rows (an agent that didn't come
   * back after a restart) are left alone. Never throws.
   */
  async reconcile(): Promise<void> {
    if (!this.orphansLeft) return;
    let undecided = false;
    try {
      const rows = this.d.store
        .list()
        .filter(
          (n) =>
            !n.read &&
            n.kind === "waiting" &&
            n.source === "den" &&
            n.subject.startsWith("agent:") &&
            !this.waiting.has(n.subject.slice("agent:".length)),
        )
        .flatMap((n) => {
          const why = rowWhy(n);
          return why ? [{ n, why }] : [];
        });
      if (!rows.length) {
        this.orphansLeft = false;
        return;
      }
      const agents = [
        ...new Set(rows.map((x) => x.n.subject.slice("agent:".length))),
      ];
      const ended = this.d.ended ? await this.d.ended(agents) : new Map();
      for (const { n, why } of rows) {
        const agent = n.subject.slice("agent:".length);
        if (this.waiting.has(agent)) continue;
        const how = ended.get(agent);
        const drop = () => this.d.store.remove((x) => x.id === n.id);
        // An ask ends with its agent stopped or removed; Den holds it
        // across its session ending by itself (as sweepEnded).
        const dialog = why === "asked" && n.msg?.vars.dialog === 1;
        if (
          how === "stopped" ||
          (how === "exited" && (why !== "asked" || dialog))
        ) {
          drop();
          continue;
        }
        if (why === "permission") {
          const open = this.d.dialogOpen
            ? await this.d.dialogOpen(agent).catch(() => null)
            : true;
          if (open === null) {
            undecided = true;
            continue;
          }
          if (!open) {
            drop();
            continue;
          }
        }
        const at = Date.parse(n.at);
        const what = n.msg?.vars.what;
        this.waiting.set(agent, {
          why,
          text: n.text,
          what: typeof what === "string" ? what : "",
          at: Number.isFinite(at) ? at : this.now(),
          mark: await this.d.outputMark(agent),
          workspace: n.scope.startsWith("workspace/")
            ? n.scope.slice("workspace/".length)
            : n.scope,
          byHook: !!this.d.hooked?.(agent),
          ...(why === "asked" && n.msg?.vars.turn === 1 ? { turn: true } : {}),
          ...(dialog ? { dialog: true } : {}),
        });
      }
    } catch {
      undecided = true;
    }
    this.orphansLeft = undecided;
  }

  /** The agent stopped or was removed: nothing waits on it. */
  gone(agent: string): void {
    this.lastRun.delete(agent);
    this.working.delete(agent);
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
      if (how === "exited" && w.why === "asked" && !w.dialog) continue;
      this.clear(agent);
    }
  }
}

/**
 * P0-D2: whether `text` names `key`, case aside: whole, never inside a
 * longer word or id.
 */
function namesKey(text: string, key: string): boolean {
  const esc = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^A-Za-z0-9_-])${esc}($|[^A-Za-z0-9_-])`, "i").test(
    text,
  );
}

/**
 * P0-D2: the versions a question names ("v3", "version 3"), links aside
 * (a "/v4/" inside a URL is no version asked about).
 */
function askedVersions(text: string): Set<number> {
  const plain = text.replace(/\bhttps?:\/\/\S+/gi, " ");
  const out = new Set<number>();
  for (const m of plain.matchAll(/\b(?:v|version\s+)(\d+)\b/gi))
    out.add(Number(m[1]));
  return out;
}
