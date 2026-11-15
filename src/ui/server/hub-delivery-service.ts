/**
 * 0.4.40 comment delivery, as this server runs it: one DeliveryLoop over
 * Hub's stream (or its list), handing comments to this install's agents
 * (agent-ops: agentInputState, typeIntoAgent), with a pump every 2 s for
 * heartbeats, queued deliveries and finished turns. Started when Hub is
 * set; stopped and started again on connect and disconnect. Who "your
 * person" is comes from whoami (person.id, else login), read at start.
 */
import path from "node:path";
import {
  SeenDeliveries,
  type DeliveryOwner,
} from "../../shared/hub-delivery.js";
import {
  DeliveryLoop,
  type AgentHubWork,
} from "../../shared/hub-delivery-loop.js";
import { listRecords, readRecord } from "../../shared/agents/records.js";
import { isServerScope } from "../../shared/agents/server-agent.js";
import {
  InboxWatcher,
  type InboxSettings,
} from "../../shared/hub-inbox-watch.js";
import { getStateDir } from "../../shared/paths.js";

const PUMP_MS = 2000;

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
let lastOpts: Parameters<typeof startDeliveries>[0] | null = null;
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
  if (pumpTimer) clearInterval(pumpTimer);
  pumpTimer = null;
  if (notesTimer) clearInterval(notesTimer);
  notesTimer = null;
  if (inboxTimer) clearInterval(inboxTimer);
  inboxTimer = null;
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

/**
 * Start (or restart) reading Hub's deliveries. `waiting`: the agents with
 * an approval waiting for their person (never typed into then).
 */
export async function startDeliveries(o: {
  heartbeatSeconds: number;
  pollSeconds: number;
  waiting: () => ReadonlySet<string>;
  log: (line: string) => void;
}): Promise<void> {
  lastOpts = o;
  stopDeliveries();
  const at = await hubAndToken().catch(() => null);
  if (!at) return;
  const hub = await import("../../shared/hub.js");
  const ops = await import("../cli/agent-ops.js");
  const { webDeps } = await import("./agent-routes.js");
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
  const d = webDeps();
  loop ??= new DeliveryLoop({
    hub: {
      stream: (lastId, signal) =>
        (async function* () {
          const a = await hubAndToken();
          if (!a)
            throw Object.assign(new Error("not connected"), {
              kind: "refused",
            });
          const res = await hub.hubOpenDeliveryStream(a.url, a.token, lastId, {
            signal,
          });
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
    },
    owner: () => owner,
    ownerWanted: () => ownerWanted(),
    seen: new SeenDeliveries(
      path.join(getStateDir(), "hub", "deliveries-seen.json"),
    ),
    heartbeatMs: o.heartbeatSeconds * 1000,
    pollMs: o.pollSeconds * 1000,
    log: o.log,
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
  const c = (ctl = new AbortController());
  let pumping = false;
  pumpTimer = setInterval(() => {
    if (pumping) return;
    pumping = true;
    void l.pump().finally(() => (pumping = false));
  }, PUMP_MS);
  pumpTimer.unref();
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
  void l
    .run(c.signal)
    .catch((e) =>
      o.log(
        `hub deliveries stopped: ${String((e as Error)?.message ?? e).slice(0, 200)}`,
      ),
    );
}

/** Connect (or reconnect): start again with the options last given. */
export function restartDeliveries(): void {
  if (lastOpts) void startDeliveries(lastOpts);
}
