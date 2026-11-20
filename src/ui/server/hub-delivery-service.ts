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
import path from "node:path";
import {
  deliveryAlert,
  readDeliveryHealth,
  SeenDeliveries,
  writeDeliveryHealth,
  type Delivery,
  type DeliveryOwner,
} from "../../shared/hub-delivery.js";
import { hubCommentsBell } from "./hub-comments-bell.js";
import {
  DeliveryLoop,
  type AgentHubWork,
} from "../../shared/hub-delivery-loop.js";
import {
  listRecords,
  readRecord,
  type AgentRecord,
} from "../../shared/agents/records.js";
import { isServerScope } from "../../shared/agents/server-agent.js";
import {
  feedKinds,
  InboxWatcher,
  type InboxSettings,
} from "../../shared/hub-inbox-watch.js";
import { getStateDir } from "../../shared/paths.js";

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
interface StartOpts {
  heartbeatSeconds: number;
  pollSeconds: number;
  /** Issue 664: hub.delivery_held_note_seconds (default 60). */
  heldNoteSeconds?: number;
  waiting: () => ReadonlySet<string>;
  log: (line: string) => void;
}
let lastOpts: StartOpts | null = null;
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
      const { syncHubNotes } = await import("../../shared/hub-notes-sync.js");
      const { notificationDeps } = await import("./notification-service.js");
      await syncHubNotes({
        store: notificationDeps().store,
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

/**
 * Issue 664: the bell's item for text held because `agent` isn't at its
 * input prompt: added once it has waited `afterSeconds`, said again each
 * minute while it waits (how long, and why), withdrawn when n is 0.
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
  } = {},
): void {
  const subject = `record:not-at-prompt:${agent}`;
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
      text: `${name}: ${n} message${n === 1 ? " waits" : "s wait"} for ${m} min. Waiting: the agent isn't at its prompt`,
      msg: { key: "bell.m.notAtPrompt", vars: { name, n, m } },
      link: `/agents?project=${encodeURIComponent(rec.workspace)}&agent=${encodeURIComponent(rec.id)}`,
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
      type: (id, text) => ops.typeIntoAgent(d, id, text),
      notAtPrompt: (id) => ops.heldNotAtPrompt(id),
    },
    // Issue 664: text held because the agent isn't at its prompt: the
    // bell says so once it has waited hub.delivery_held_note_seconds, and
    // keeps saying it (refreshed each minute) until it's typed.
    heldNote: (agent, n, waitedMs) =>
      heldBell(agent, n, waitedMs, lastOpts?.heldNoteSeconds ?? 60),
    owner: () => owner,
    ownerWanted: () => ownerWanted(),
    seen: new SeenDeliveries(
      path.join(getStateDir(), "hub", "deliveries-seen.json"),
    ),
    heartbeatMs: o.heartbeatSeconds * 1000,
    pollMs: o.pollSeconds * 1000,
    log: o.log,
    // Issue 702: doctor reads the path's health from a file.
    onHealth: (h) => writeDeliveryHealth(healthFile(), h, streamUrl),
    health0: {
      lastDeliveryAt: readDeliveryHealth(healthFile())?.lastDeliveryAt ?? null,
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
  owner = null;
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

/** Issue 334: how many relayed messages wait for `agent`. */
export function relayedWaiting(agent: string): number {
  return loop?.work(agent)?.queued ?? 0;
}

/** Connect (or reconnect): start again with the options last given. */
export function restartDeliveries(): void {
  if (lastOpts) void startDeliveries(lastOpts);
}
