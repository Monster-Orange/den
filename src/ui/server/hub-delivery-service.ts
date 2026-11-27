/**
 * 0.4.40 comment delivery, as this server runs it: one DeliveryLoop over
 * Hub's stream (or its list), handing comments to this install's agents
 * (agent-ops: agentInputState, typeIntoAgent), with a pump every 2 s for
 * heartbeats, queued deliveries and finished turns. Started when Hub is
 * set; stopped and started again on connect and disconnect. Who "your
 * person" is comes from whoami (person.id, else login), read at start.
 *
 * Issue 334: the loop and its pump run with or without Hub: a web app's
 * relayed message (relayMessage) is held and typed by the same loop, after
 * the agent's turn, never mid-turn. Hub's own deliveries need Hub.
 */
import { agentPagePath } from "../../shared/agent-links.js";
import path from "node:path";
import type * as AgentOps from "../cli/agent-ops.js";
import type { AgentsResolved } from "../cli/agent-ops.js";
import {
  deliveryAlert,
  readDeliveryHealth,
  toolsHeldAck,
  SeenDeliveries,
  writeDeliveryHealth,
  type Delivery,
  type DeliveryOwner,
} from "../../shared/hub/hub-delivery.js";
import { appendJournal } from "../../shared/hub/hub-delivery-journal.js";
import { hubCommentsBell } from "./hub-comments-bell.js";
import {
  DeliveryLoop,
  HELD_WORDS,
  type AgentHubWork,
  type HeldCode,
} from "../../shared/hub/hub-delivery-loop.js";
import {
  listRecords,
  readRecord,
  type AgentRecord,
} from "../../shared/agents/records.js";
import { isServerScope } from "../../shared/agents/server-agent.js";
import { hubToolsFailed } from "../../shared/agents/hub-mcp-connect.js";
import {
  feedKinds,
  InboxWatcher,
  type InboxSettings,
} from "../../shared/hub/hub-inbox-watch.js";
import { getStateDir } from "../../shared/paths.js";
import { readUserConfig } from "../../shared/den-config.js";
import { embedSettings } from "./embed-settings.js";

const PUMP_MS = 2000;
/** Issue 702: how often the bell checks hub.delivery_alert_minutes. */
const ALERT_CHECK_MS = 30_000;
/** Issue 702: doctor's copy of the delivery path's health. */
const healthFile = () =>
  path.join(getStateDir(), "hub", "deliveries-health.json");
/** Issue 702: the Hub the stream last opened to (doctor shows it). */
let streamUrl: string | null = null;
let alertTimer: NodeJS.Timeout | null = null;
let bell: ReturnType<typeof hubCommentsBell> | null = null;

let loop: DeliveryLoop | null = null;
let ctl: AbortController | null = null;
let pumpTimer: NodeJS.Timeout | null = null;
/** NT-6: Hub's notifications into the bell, while Hub is connected. */
let notesTimer: NodeJS.Timeout | null = null;
/**
 * Who this Den's person is in Hub (whoami), or null until Hub has said.
 * Null holds deliveries, so a person's edit request never reads as
 * "someone else" because Hub was down when Den started.
 */
let owner: DeliveryOwner | null = null;
let ownerAsking = false;
let ownerAskedAt = 0;
let ownerWanted: () => void = () => undefined;
/** #65: the inbox kinds Hub's feed carries (whoami features). */
let feedCarries: ReadonlySet<string> = new Set();
/** Issue 750: Hub takes the `held` ack (whoami lists deliveries.ack_held). */
let ackHeldOn = false;
interface StartOpts {
  heartbeatSeconds: number;
  pollSeconds: number;
  /** Issue 664: hub.delivery_held_note_seconds (default 60). */
  heldNoteSeconds?: number;
  waiting: () => ReadonlySet<string>;
  /**
   * Issue 701: what `agent` waits on for its person ("permission",
   * "approval", "paused"), or null.
   */
  waitingWhy?: (agent: string) => string | null;
  /**
   * Issue 701: hub.delivery_state_timeout_seconds (60),
   * hub.delivery_type_timeout_seconds (120), hub.delivery_held_bell_minutes
   * (5), hub.delivery_answer_minutes (30).
   */
  stateTimeoutSeconds?: number;
  typeTimeoutSeconds?: number;
  heldBellMinutes?: number;
  answerMinutes?: number;
  log: (line: string) => void;
}

/** Issue 701: the reasons the install's waiting marks give. */
const MARK_CODES: ReadonlySet<string> = new Set([
  "permission",
  "approval",
  "paused",
]);

/**
 * Issue 701, 962: why a busy agent holds its Hub deliveries, or null
 * (mid-turn). A trust or permission dialog by its name; then Den's own
 * holds (an Allow, a pause); then a list or a question on its screen,
 * which the screen check reads as a dialog: the agent isn't at its prompt.
 */
export async function heldWhyOf(
  ops: Pick<
    typeof AgentOps,
    "agentDialogKind" | "agentScreenShowsDialog" | "heldForDraft"
  >,
  d: AgentsResolved,
  id: string,
  waitingWhy?: (id: string) => string | null,
): Promise<HeldCode | null> {
  const dialog = await ops.agentDialogKind(d, id);
  if (dialog) return dialog;
  const why = waitingWhy?.(id) ?? null;
  if (why && MARK_CODES.has(why)) return why as HeldCode;
  // Issue 1311: its person's unsent draft on the line.
  if (ops.heldForDraft(id)) return "draft";
  return (await ops.agentScreenShowsDialog(d, id)) ? "not_at_prompt" : null;
}

/** Issue 701: how long a held item waits before the bell says so, in s. */
function heldBellAfter(why: HeldCode | undefined): number {
  if (!why || why === "not_at_prompt") return lastOpts?.heldNoteSeconds ?? 60;
  return (lastOpts?.heldBellMinutes ?? 5) * 60;
}
let lastOpts: StartOpts | null = null;

/** Issue 1311: agents.draft_hold_max_minutes, in s (its default if unreadable). */
function draftBellAfter(d: AgentsResolved): number {
  try {
    return (d.agentsConfig().draftHoldMaxMs ?? 30 * 60_000) / 1000;
  } catch {
    return 30 * 60;
  }
}

/**
 * Issue 1311: how many Hub items wait for agent `agent` on its person's
 * unsent draft (the terminal's "N messages waiting").
 */
export function hubWaitingOnDraft(agent: string): number {
  return loop?.waitingOnDraft(agent) ?? 0;
}
/** Issue 166: Hub's inbox, read for this install's agents. */
let inbox: InboxWatcher | null = null;
let inboxTimer: NodeJS.Timeout | null = null;

async function hubAndToken(): Promise<{ url: string; token: string } | null> {
  const hub = await import("../../shared/hub.js");
  const cfg = hub.readHubConfig();
  if (!cfg) return null;
  const token = await hub.readHubToken(cfg);
  return token ? { url: cfg.url, token } : null;
}

async function syncAgentGrant(url: string): Promise<void> {
  try {
    const g = await import("../../shared/hub-agent-grant.js");
    const { getStateDir } = await import("../../shared/paths.js");
    const { notificationDeps } = await import("./notification-service.js");
    g.syncAgentGrantNote(notificationDeps().store, {
      connected: true,
      notCovered: g.agentsNotCovered(getStateDir(), url),
    });
  } catch {
    return;
  }
}

/** The body of a fetch Response as text chunks. */
async function* chunks(res: Response): AsyncIterable<string> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      yield dec.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}

/** What an agent's card shows, or null (the sessions list reads it). */
export function agentHubWork(agent: string): AgentHubWork | null {
  return loop?.work(agent) ?? null;
}

/** Stop reading Hub (disconnect, shutdown). Queued work is kept in memory. */
export function stopDeliveries(): void {
  ctl?.abort();
  ctl = null;
  // Issue 334: the pump goes on (relayed messages need no Hub); Hub's own
  // deliveries wait until Hub says again who the person is.
  owner = null;
  if (notesTimer) clearInterval(notesTimer);
  notesTimer = null;
  if (inboxTimer) clearInterval(inboxTimer);
  inboxTimer = null;
  if (alertTimer) clearInterval(alertTimer);
  alertTimer = null;
  // Issue 702: not reading Hub (disconnected): nothing to say.
  bell?.(null);
}

/**
 * Issue 726: the Hub changed. Stop reading it, and drop what the loops
 * hold in memory (seen ids, the cursor, held comments, the inbox's since),
 * so the next start reads the fresh files and nothing from the old Hub is
 * typed or reported to the new one. A relay's next message makes a new
 * loop at once (Den's own relays were kept in the fresh file).
 */
export function dropDeliveryState(): void {
  stopDeliveries();
  if (pumpTimer) clearInterval(pumpTimer);
  pumpTimer = null;
  loop = null;
  inbox = null;
  streamUrl = null;
  heldSaid.clear();
}

/** hub.delivery_alert_minutes, read each time (a bad hub block: 15). */
async function alertMinutes(): Promise<number> {
  const hub = await import("../../shared/hub.js");
  try {
    return hub.readHubConfig()?.deliveryAlertMinutes ?? 15;
  } catch {
    return 15;
  }
}

/**
 * Issue 702: say "Hub comments aren't arriving" in the bell after
 * hub.delivery_alert_minutes with no good read; withdrawn on the next.
 */
function startDeliveryAlert(l: DeliveryLoop): void {
  if (alertTimer) clearInterval(alertTimer);
  const check = async () => {
    const reason = deliveryAlert(l.health(), Date.now(), await alertMinutes());
    const { notificationDeps } = await import("./notification-service.js");
    bell ??= hubCommentsBell(notificationDeps().store);
    bell(reason);
  };
  alertTimer = setInterval(
    () => void check().catch(() => undefined),
    ALERT_CHECK_MS,
  );
  alertTimer.unref();
}

/** hub.inbox_* read each time (a bad hub block: the defaults). */
async function inboxSettings(): Promise<InboxSettings> {
  const hub = await import("../../shared/hub.js");
  try {
    const c = hub.readHubConfig();
    if (c)
      return {
        on: c.inboxWatch,
        pollSeconds: c.inboxPollSeconds,
        backoffMaxSeconds: c.inboxBackoffMaxSeconds,
        readsPerSecond: c.inboxReadsPerSecond,
      };
  } catch {
    /* doctor says so; the defaults meanwhile */
  }
  return { on: true, pollSeconds: 30, backoffMaxSeconds: 600 };
}

/** notifications.hub_poll_seconds, read each time (0: off; bad: 60). */
async function hubPollSeconds(): Promise<number> {
  const { readDenConfig, readUserConfig } =
    await import("../../shared/den-config.js");
  const { readNotificationConfig } =
    await import("../../shared/notifications.js");
  try {
    return readNotificationConfig(readDenConfig(), readUserConfig())
      .hubPollSeconds;
  } catch {
    return 60; // a bad value: doctor says so; the default meanwhile
  }
}

/**
 * NT-6: read Hub's notifications every `notifications.hub_poll_seconds`,
 * first right away. A 10 s beat checks whether a pass is due, so a change
 * to the setting counts without a restart.
 */
function startHubNotes(log: (line: string) => void): void {
  let busy = false;
  let lastSaid = "";
  let last = 0;
  const due = async (force: boolean) => {
    if (busy) return;
    const every = await hubPollSeconds();
    if (!every || (!force && Date.now() - last < every * 1000)) return;
    busy = true;
    last = Date.now();
    try {
      const at = await hubAndToken().catch(() => null);
      if (!at) return;
      const hub = await import("../../shared/hub.js");
      const { syncHubNotes } =
        await import("../../shared/hub/hub-notes-sync.js");
      const { notificationDeps } = await import("./notification-service.js");
      await syncHubNotes({
        store: notificationDeps().store,
        hubUrl: at.url,
        owner: () => owner?.ownerLogin ?? null,
        list: () => hub.hubNotifications(at.url, at.token),
        markRead: (ids) => hub.hubMarkNotificationsRead(at.url, at.token, ids),
        // Once per different reason, not every pass.
        log: (line) => {
          if (line !== lastSaid) log(line);
          lastSaid = line;
        },
      });
    } finally {
      busy = false;
    }
  };
  void due(true).catch(() => undefined);
  notesTimer = setInterval(
    () => void due(false).catch(() => undefined),
    10_000,
  );
  notesTimer.unref();
}

/** Issue 664: when each agent's held-text bell item was last said. */
const heldSaid = new Map<string, number>();

type HeldStore = Pick<
  import("../../shared/notifications.js").NotificationStore,
  "add" | "withdraw"
>;

export function badDeliveryFile(
  aside: string,
  o: {
    held?: number | null;
    code?: string;
    store?: HeldStore;
    log?: (line: string) => void;
  } = {},
): void {
  const file = path.basename(aside).replace(/\.bad-\d+$/, "");
  const moved = path.basename(aside);
  const n = o.held ?? null;
  const kept = moved !== file;
  const key = !kept
    ? "bell.m.deliveryFileBadKept"
    : n === null
      ? "bell.m.deliveryFileBadUncounted"
      : "bell.m.deliveryFileBad";
  const text = !kept
    ? `Den couldn't read ${file} and couldn't move it aside; delivery goes on without what it held.`
    : n === null
      ? `Den couldn't read ${file} or count its held deliveries; kept the file as ${moved}.`
      : `Den couldn't read ${n} held deliver${n === 1 ? "y" : "ies"}; kept the file as ${moved}.`;
  const go = (s: HeldStore) =>
    s.add({
      kind: "service",
      subject: `record:delivery-file-bad:${moved}`,
      scope: "den",
      text,
      msg: { key, vars: n === null ? { file, moved } : { file, moved, n } },
      link: "/settings",
    });
  if (o.store) go(o.store);
  else
    void import("./notification-service.js")
      .then(({ notificationDeps }) => go(notificationDeps().store))
      .catch(() => undefined);
  try {
    o.log?.(`hub delivery: ${text}${o.code ? ` (${o.code})` : ""}`);
  } catch {
    return;
  }
}

/**
 * Issue 664: the bell's item for text held because `agent` isn't at its
 * input prompt: added once it has waited `afterSeconds`, said again each
 * minute while it waits (how long, and why), withdrawn when n is 0.
 * Issue 701: the same item for every reason it waits (`why`; none: not at
 * its prompt).
 */
export function heldBell(
  agent: string,
  n: number,
  waitedMs: number,
  afterSeconds: number,
  o: {
    store?: HeldStore;
    recOf?: (id: string) => AgentRecord | null;
    now?: number;
    why?: HeldCode;
  } = {},
): void {
  const subject = `record:not-at-prompt:${agent}`;
  const why = o.why ?? "not_at_prompt";
  const said = heldSaid.get(agent);
  const now = o.now ?? Date.now();
  if (n <= 0) {
    if (said === undefined) return;
    heldSaid.delete(agent);
  } else if (
    waitedMs < afterSeconds * 1000 ||
    (said !== undefined && now - said < 60_000)
  )
    return;
  else heldSaid.set(agent, now);
  const go = (s: HeldStore) => {
    if (n <= 0) {
      s.withdraw(subject, "service");
      return;
    }
    const rec = (o.recOf ?? ((id) => readRecord(getStateDir(), id)))(agent);
    if (!rec) return;
    const name = rec.displayName || rec.persona || rec.id;
    const m = Math.max(1, Math.round(waitedMs / 60_000));
    s.add({
      kind: "service",
      subject,
      scope: `workspace/${rec.workspace}`,
      text: `${name}: ${n} message${n === 1 ? " waits" : "s wait"} for ${m} min. Waiting: ${why === "not_at_prompt" ? "the agent isn't at its prompt" : HELD_WORDS[why]}`,
      msg: {
        key:
          why === "not_at_prompt" ? "bell.m.notAtPrompt" : `bell.m.held.${why}`,
        vars: { name, n, m },
      },
      link: agentPagePath(rec.workspace, rec.id),
    });
  };
  if (o.store) {
    try {
      go(o.store);
    } catch {
      /* the bell is best effort: the row still says it */
    }
    return;
  }
  void import("./notification-service.js")
    .then(({ notificationDeps }) => go(notificationDeps().store))
    .catch(() => undefined);
}

/**
 * The loop and its pump, made once (issue 334: with or without Hub). Hub's
 * calls look Hub up each time: no Hub, nothing is read or acked.
 */
async function ensureLoop(o: StartOpts): Promise<DeliveryLoop> {
  if (loop && pumpTimer) return loop;
  const hub = await import("../../shared/hub.js");
  const ops = await import("../cli/agent-ops.js");
  const { webDeps } = await import("./agent-routes.js");
  if (loop && pumpTimer) return loop;
  const d = webDeps();
  loop = new DeliveryLoop({
    hub: {
      stream: (lastId, signal) =>
        (async function* () {
          const a = await hubAndToken();
          if (!a)
            throw Object.assign(new Error("not connected"), {
              kind: "refused",
            });
          streamUrl = a.url;
          const res = await hub.hubOpenDeliveryStream(a.url, a.token, lastId, {
            signal,
          });
          // Issue 702: the stream opened: a good read before any bytes.
          yield "";
          yield* chunks(res);
        })(),
      list: async (after) => {
        const a = await hubAndToken();
        return a ? hub.hubListDeliveries(a.url, a.token, after) : [];
      },
      ack: async (id, body) => {
        const a = await hubAndToken();
        if (a) await hub.hubAckDelivery(a.url, a.token, id, body);
      },
    },
    agents: {
      state: (id) => ops.agentInputState(d, id, o.waiting()),
      // Issue 1311: a draft on the line: false at once; this queue keeps
      // the items, in order, and types them once the draft is gone.
      type: (id, text) => ops.typeIntoAgent(d, id, text, { onDraft: "refuse" }),
      notAtPrompt: (id) => ops.heldNotAtPrompt(id),
      why: (id) => heldWhyOf(ops, d, id, (x) => o.waitingWhy?.(x) ?? null),
      // Issue 750: its Hub tools failed to load (issue 749's record).
      hubTools: (id) => {
        const rec = readRecord(getStateDir(), id);
        return rec && hubToolsFailed(getStateDir(), rec) ? false : null;
      },
    },
    // Issue 701: the person's comment answers the agent's question.
    answered: (agent) => {
      void import("./notification-service.js")
        .then(({ notificationDeps }) =>
          notificationDeps().attention.answered(agent),
        )
        .catch(() => undefined);
    },
    // P0-D2: an owner's approval clears the questions that name it, on
    // arrival; another agent whose question named it is told.
    approved: (dv) => {
      void Promise.all([
        import("./notification-service.js"),
        import("./hub-approval.js"),
      ])
        .then(([{ notificationDeps }, { settleApproval }]) =>
          settleApproval(dv, {
            approvedAbout: (a, ws, keys, version) =>
              notificationDeps().attention.approvedAbout(a, ws, keys, version),
            log: (l) => o.log(l),
            workspaceOf: (a) => readRecord(getStateDir(), a)?.workspace ?? null,
            owner: () => owner,
            takeLocal: (x) =>
              loop ? loop.takeLocal(x) : Promise.resolve(false),
          }),
        )
        .catch(() => undefined);
    },
    // Issue 664: text held because the agent isn't at its prompt: the
    // bell says so once it has waited hub.delivery_held_note_seconds, and
    // keeps saying it (refreshed each minute) until it's typed.
    // Issue 701: and for every other reason, after
    // hub.delivery_held_bell_minutes.
    // Issue 1311: held on a draft, after agents.draft_hold_max_minutes.
    heldNote: (agent, n, waitedMs, why) =>
      heldBell(
        agent,
        n,
        waitedMs,
        why === "draft" ? draftBellAfter(d) : heldBellAfter(why),
        { why },
      ),
    stateTimeoutMs: (o.stateTimeoutSeconds ?? 60) * 1000,
    typeTimeoutMs: (o.typeTimeoutSeconds ?? 120) * 1000,
    answerTimeoutMs: (o.answerMinutes ?? 30) * 60_000,
    // Issue 701: typed comments with no answer yet: the bell says so.
    noAnswer: (agent, w) => {
      void import("./notification-service.js")
        .then(({ notificationDeps }) => {
          const rec = readRecord(getStateDir(), agent);
          if (rec)
            notificationDeps().attention.hubNoAnswer(agent, rec.workspace, w);
        })
        .catch(() => undefined);
    },
    owner: () => owner,
    ownerWanted: () => ownerWanted(),
    ackHeld: () => deliveryAckHeld(),
    seen: new SeenDeliveries(
      path.join(getStateDir(), "hub", "deliveries-seen.json"),
      5000,
      {
        onBad: (aside, held, code) =>
          badDeliveryFile(aside, { held, code, log: o.log }),
      },
    ),
    // Issue 459: app feed pointers keep their own seen ids.
    feedSeen: new SeenDeliveries(
      path.join(getStateDir(), "hub", "feed-pointers-seen.json"),
      5000,
      {
        onBad: (aside, held, code) =>
          badDeliveryFile(aside, { held, code, log: o.log }),
      },
    ),
    // Issue 459: one paste holds at most embed.paste_max_kb.
    pasteMaxChars: () => {
      try {
        return embedSettings(readUserConfig()).paste_max_kb * 1024;
      } catch {
        return 256 * 1024;
      }
    },
    heartbeatMs: o.heartbeatSeconds * 1000,
    pollMs: o.pollSeconds * 1000,
    log: o.log,
    // P0-D4: every delivery's outcome, for doctor (no body or name).
    journal: (e) =>
      appendJournal(path.join(getStateDir(), "hub", "deliveries.jsonl"), e),
    // Issue 702: doctor reads the path's health from a file.
    onHealth: (h) => writeDeliveryHealth(healthFile(), h, streamUrl),
    health0: (() => {
      const h0 = readDeliveryHealth(healthFile());
      return {
        lastDeliveryAt: h0?.lastDeliveryAt ?? null,
        // A restart keeps how long the cursor has been still.
        cursorAt: h0?.cursorAt ?? null,
      };
    })(),
    // hub.delivery_stale_hours, read at each check.
    staleMs: () => {
      try {
        return (hub.readHubConfig()?.deliveryStaleHours ?? 6) * 3_600_000;
      } catch {
        return 6 * 3_600_000;
      }
    },
    // Issue 703: hub.delivery_stream_silence_seconds, read at each open.
    silenceMs: () => {
      try {
        return (hub.readHubConfig()?.deliveryStreamSilenceSeconds ?? 75) * 1000;
      } catch {
        return 75_000;
      }
    },
    // Issue 271: an owner decided a held change an agent asked for: read
    // the waiting new-project asks again now (one links on its own).
    held: () => {
      void import("./hub-create-routes.js")
        .then((m) => m.settleAllHubCreates())
        .catch(() => undefined);
    },
    // NT: the bell says it, from the agent's own record's project.
    finished: (agent, w) => {
      void import("./notification-service.js").then(({ notificationDeps }) => {
        const rec = readRecord(getStateDir(), agent);
        if (rec)
          notificationDeps().attention.hubFinished(agent, rec.workspace, w);
      });
    },
  });
  const l = loop;
  let pumping = false;
  pumpTimer = setInterval(() => {
    if (pumping) return;
    pumping = true;
    void l.pump().finally(() => (pumping = false));
  }, PUMP_MS);
  pumpTimer.unref();
  return l;
}

/**
 * Issue 750 step 4: what Hub's whoami lists, kept for the loop: the inbox
 * kinds its feed carries (#65), and whether an agent whose Hub tools
 * failed gets a `held` ack (deliveries.ack_held) or `queued` (an older
 * Hub, or no answer). Reads only whoami: hub.groups never changes it.
 */
export function noteWhoami(
  w: { features?: readonly string[] } | null | undefined,
): void {
  feedCarries = feedKinds(w?.features);
  ackHeldOn = toolsHeldAck(w?.features).state === "held";
}

/** Issue 750 step 4: whether the loop acks `held` (else `queued`). */
export function deliveryAckHeld(): boolean {
  return ackHeldOn;
}

/**
 * Start (or restart) reading Hub's deliveries. `waiting`: the agents with
 * a held Allow, a permission prompt or an ask_human question waiting for
 * their person (never typed into then); an idle one is not among them.
 */
export async function startDeliveries(o: StartOpts): Promise<void> {
  lastOpts = o;
  stopDeliveries();
  const l = await ensureLoop(o);
  const at = await hubAndToken().catch(() => null);
  if (!at) return;
  const hub = await import("../../shared/hub.js");
  // Ask Hub who this Den's person is; again when a delivery waits on it,
  // at most once per poll interval (hub.delivery_poll_seconds).
  const askOwner = async (): Promise<void> => {
    if (ownerAsking) return;
    ownerAsking = true;
    ownerAskedAt = Date.now();
    try {
      const a = await hubAndToken();
      if (!a) return;
      const w = await hub.hubWhoami(a.url, a.token);
      owner = {
        ...(w.personId ? { ownerId: w.personId } : {}),
        ...(w.login ? { ownerLogin: w.login } : {}),
        ...(w.company?.name ? { company: w.company.name } : {}),
      };
      feedCarries = feedKinds(w.features);
      void syncAgentGrant(a.url);
      noteWhoami(w);
    } catch {
      /* Hub unreachable now: deliveries wait until it answers */
    } finally {
      ownerAsking = false;
    }
  };
  ownerWanted = () => {
    if (Date.now() - ownerAskedAt >= o.pollSeconds * 1000) void askOwner();
  };
  // A new connection may be a different person: never keep the old one.
  // Issue 750: nor the old Hub's features (until it says, `queued`).
  owner = null;
  loop?.ownerReset();
  ackHeldOn = false;
  ownerAskedAt = 0;
  await askOwner();
  startHubNotes(o.log);
  // Issue 166: Hub's inbox (approvals, requested changes, comments) into
  // the same loop, so they wake an idle agent or wait for its next turn.
  let settings: InboxSettings = await inboxSettings();
  inbox ??= new InboxWatcher({
    fetchInbox: async (agent) => {
      const a = await hubAndToken();
      if (!a) throw new Error("not connected");
      return hub.hubInbox(a.url, a.token, agent);
    },
    agents: () =>
      listRecords(getStateDir())
        .filter((r) => !isServerScope(r.workspace))
        .map((r) => r.id),
    loop: l,
    owner: () => owner,
    feedCarries: () => feedCarries,
    settings: () => settings,
    stateFile: path.join(getStateDir(), "hub", "inbox-watch.json"),
    log: o.log,
  });
  const w = inbox;
  inboxTimer = setInterval(() => {
    void inboxSettings()
      .then((v) => (settings = v))
      .then(() => w.tick())
      .catch(() => undefined);
  }, PUMP_MS);
  inboxTimer.unref();
  const c = (ctl = new AbortController());
  startDeliveryAlert(l);
  void l
    .run(c.signal)
    .catch((e) =>
      o.log(
        `hub deliveries stopped: ${String((e as Error)?.message ?? e).slice(0, 200)}`,
      ),
    );
}

/**
 * Issue 334: hold a web app's relayed message for its agent: typed after
 * the agent's turn, at its next start when it's stopped, never while it
 * waits on its person. False before the server started the loop.
 */
export async function relayMessage(dv: Delivery): Promise<boolean> {
  if (!lastOpts) return false;
  const l = await ensureLoop(lastOpts);
  return l.takeLocal(dv);
}

/** Issue 459: whether the loop has taken (or passed over) Den's own item `id`. */
export function relaySeen(id: string): boolean {
  return loop?.seenLocal(id) ?? false;
}

/** Issue 459: whether the loop still waits to type (or is typing) `id`. */
export function relayHolds(id: string): boolean {
  return loop?.holds(id) ?? false;
}

/** Issue 334: how many relayed messages wait for `agent`. */
export function relayedWaiting(agent: string): number {
  return loop?.work(agent)?.queued ?? 0;
}

/** Connect (or reconnect): start again with the options last given. */
export function restartDeliveries(): void {
  if (lastOpts) void startDeliveries(lastOpts);
}
