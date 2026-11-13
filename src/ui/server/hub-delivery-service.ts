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
import { getStateDir } from "../../shared/paths.js";

const PUMP_MS = 2000;

let loop: DeliveryLoop | null = null;
let ctl: AbortController | null = null;
let pumpTimer: NodeJS.Timeout | null = null;
let owner: DeliveryOwner = {};
let lastOpts: Parameters<typeof startDeliveries>[0] | null = null;

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
  try {
    const w = await hub.hubWhoami(at.url, at.token);
    owner = {
      ...(w.personId ? { ownerId: w.personId } : {}),
      ...(w.login ? { ownerLogin: w.login } : {}),
      ...(w.company?.name ? { company: w.company.name } : {}),
    };
  } catch {
    /* Hub unreachable now: every comment reads as information until it is */
  }
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
    seen: new SeenDeliveries(
      path.join(getStateDir(), "hub", "deliveries-seen.json"),
    ),
    heartbeatMs: o.heartbeatSeconds * 1000,
    pollMs: o.pollSeconds * 1000,
    log: o.log,
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
