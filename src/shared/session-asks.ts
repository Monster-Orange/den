/**
 * Issue 620: a session that isn't a Den agent (a coding session in its own
 * terminal) can put a yes/no, or a few named choices, in front of the
 * person. Strictly an ask: answering it runs nothing and allows nothing.
 *
 * An ask is bound to the process that filed it: the session's own Den MCP
 * server (each session spawns its own), by pid and start time. Only that
 * process reads its answer; any other caller is told there is no such ask.
 * When that process is gone, its open asks are lost: out of Needs you, so
 * nobody answers a dead ask. The session's label is its own claim; what
 * Den found (the caller's command and folder) is kept beside it.
 *
 * The caller's text is masked (redactSecrets) before it is stored. Open
 * asks are capped per session and in all; each expires after its time.
 */
import { randomBytes } from "crypto";
import * as fs from "fs";
import { writeFileAtomic } from "./atomic-write.js";
import { redactSecrets } from "./redact.js";

export const QUESTION_MAX = 300;
export const LABEL_MAX = 60;
export const CHOICE_MAX = 40;

/** The process that filed an ask, as Den found it. */
export interface AskCaller {
  pid: number;
  /** Its start time (ps lstart), so a reused pid never matches. */
  started: string;
  /** Its command name, as Den read it (never the caller's word). */
  command?: string;
  /** Its working folder, as Den read it. */
  cwd?: string;
}

export interface AskInput {
  question: string;
  choices: string[];
  /** What the asker calls itself: a label, never checked. */
  label?: string;
}

export type AskState = "open" | "answered" | "expired" | "lost";

export interface SessionAsk extends AskInput {
  id: string;
  caller: AskCaller;
  createdAt: number;
  expiresAt: number;
  state: AskState;
  answer?: string;
  answeredAt?: number;
}

export interface AskLimits {
  /** Open asks one session (its process) may have. */
  openPerSession: number;
  /** Open asks across every session. */
  openTotal: number;
  /** How long an ask waits before it expires. */
  ttlMs: number;
}

/** Whether a caller's process still runs as the one bound. */
export type Alive = (c: AskCaller) => boolean;

const text = (v: unknown) => (typeof v === "string" ? v.trim() : undefined);

/** The ask a caller sent, checked; or why not. */
export function parseAskInput(
  b: unknown,
): { ok: true; input: AskInput } | { ok: false; error: string } {
  const o = (b && typeof b === "object" ? b : {}) as Record<string, unknown>;
  const question = text(o.question);
  if (!question) return { ok: false, error: "say what you need to ask" };
  if (question.length > QUESTION_MAX)
    return {
      ok: false,
      error: `a question is at most ${QUESTION_MAX} characters`,
    };
  let choices = ["yes", "no"];
  if (o.choices !== undefined) {
    if (
      !Array.isArray(o.choices) ||
      o.choices.length < 2 ||
      o.choices.length > 4 ||
      !o.choices.every(
        (c) =>
          typeof c === "string" && c.trim() && c.trim().length <= CHOICE_MAX,
      )
    )
      return {
        ok: false,
        error: `choices: 2 to 4, each at most ${CHOICE_MAX} characters`,
      };
    choices = (o.choices as string[]).map((c) => c.trim());
    if (new Set(choices).size !== choices.length)
      return { ok: false, error: "choices must differ" };
  }
  const label = text(o.label);
  if (label !== undefined && label.length > LABEL_MAX)
    return {
      ok: false,
      error: `the label is at most ${LABEL_MAX} characters`,
    };
  return {
    ok: true,
    input: { question, choices, ...(label ? { label } : {}) },
  };
}

/** The asks file: read whole, written whole (writeFileAtomic). */
export class SessionAskStore {
  constructor(private readonly file: string) {}

  read(): SessionAsk[] {
    try {
      const v = JSON.parse(fs.readFileSync(this.file, "utf-8")) as unknown;
      return Array.isArray(v) ? (v as SessionAsk[]) : [];
    } catch {
      return [];
    }
  }

  write(asks: SessionAsk[]): void {
    writeFileAtomic(this.file, JSON.stringify(asks, null, 2) + "\n", {
      mode: 0o600,
    });
  }
}

const same = (a: AskCaller, b: AskCaller) =>
  a.pid === b.pid && a.started === b.started;

/** Settled asks are kept a day for the audit trail, then dropped. */
const KEEP_MS = 24 * 60 * 60 * 1000;

/**
 * The asks as of `now`: open ones past their time expire, open ones whose
 * process is gone are lost, settled ones older than a day are dropped.
 * Written back when anything changed.
 */
function current(store: SessionAskStore, now: number, alive?: Alive) {
  const asks = store.read();
  let changed = false;
  const out: SessionAsk[] = [];
  for (const a of asks) {
    if (a.state === "open" && now > a.expiresAt) {
      a.state = "expired";
      changed = true;
    } else if (a.state === "open" && alive && !alive(a.caller)) {
      a.state = "lost";
      changed = true;
    }
    if (a.state !== "open" && now - (a.answeredAt ?? a.expiresAt) > KEEP_MS) {
      changed = true;
      continue;
    }
    out.push(a);
  }
  if (changed) store.write(out);
  return out;
}

/** File an ask for `caller`; its id, or why not (code for the route). */
export function fileAsk(
  store: SessionAskStore,
  caller: AskCaller,
  input: AskInput,
  limits: AskLimits,
  now: number = Date.now(),
  alive?: Alive,
):
  | { ok: true; id: string; ask: SessionAsk }
  | { ok: false; code: "ask_limit" | "ask_limit_total"; error: string } {
  const asks = current(store, now, alive);
  const open = asks.filter((a) => a.state === "open");
  if (
    open.filter((a) => same(a.caller, caller)).length >= limits.openPerSession
  )
    return {
      ok: false,
      code: "ask_limit",
      error: `you have ${limits.openPerSession} open questions (notifications.session_asks_open); wait for an answer first`,
    };
  if (open.length >= limits.openTotal)
    return {
      ok: false,
      code: "ask_limit_total",
      error: `${limits.openTotal} questions from outside Den's agents are open already (notifications.session_asks_total); wait for the person to answer some`,
    };
  const ask: SessionAsk = {
    id: `sa_${randomBytes(12).toString("hex")}`,
    question: redactSecrets(input.question),
    choices: input.choices.map(redactSecrets),
    ...(input.label ? { label: redactSecrets(input.label) } : {}),
    caller: {
      pid: caller.pid,
      started: caller.started,
      ...(caller.command ? { command: caller.command } : {}),
      ...(caller.cwd ? { cwd: caller.cwd } : {}),
    },
    createdAt: now,
    expiresAt: now + limits.ttlMs,
    state: "open",
  };
  store.write([...asks, ask]);
  return { ok: true, id: ask.id, ask };
}

/** The open asks (Needs you, the bell), oldest first. */
export function openAsks(
  store: SessionAskStore,
  now: number = Date.now(),
  alive?: Alive,
): SessionAsk[] {
  return current(store, now, alive).filter((a) => a.state === "open");
}

/** `id`, if `caller` filed it; null for anyone else, as for no such ask. */
export function askFor(
  store: SessionAskStore,
  id: string,
  caller: AskCaller,
  now: number = Date.now(),
  alive?: Alive,
): SessionAsk | null {
  const a = current(store, now, alive).find((x) => x.id === id);
  return a && same(a.caller, caller) ? a : null;
}

/** Any ask by id (the person's page and the audit), or null. */
export function askById(
  store: SessionAskStore,
  id: string,
  now: number = Date.now(),
  alive?: Alive,
): SessionAsk | null {
  return current(store, now, alive).find((x) => x.id === id) ?? null;
}

/** The person's answer: one of its choices, to an open ask. */
export function answerAsk(
  store: SessionAskStore,
  id: string,
  choice: unknown,
  now: number = Date.now(),
  alive?: Alive,
):
  | { ok: true; ask: SessionAsk }
  | { ok: false; status: number; error: string } {
  const asks = current(store, now, alive);
  const a = asks.find((x) => x.id === id);
  if (!a) return { ok: false, status: 404, error: "no such question" };
  if (a.state !== "open")
    return { ok: false, status: 409, error: `this question is ${a.state}` };
  if (typeof choice !== "string" || !a.choices.includes(choice))
    return {
      ok: false,
      status: 400,
      error: `answer one of: ${a.choices.join(", ")}`,
    };
  a.state = "answered";
  a.answer = choice;
  a.answeredAt = now;
  store.write(asks);
  return { ok: true, ask: a };
}
