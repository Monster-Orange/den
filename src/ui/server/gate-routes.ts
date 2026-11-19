/**
 * Issue 144 GATE-SLOT: the machine's gate slots on the web.
 *   GET  /api/gate-slots         who holds a slot and who waits, with the
 *                                machine's settings and the release slot
 *                                (gates/view.ts)
 *   POST /api/gate-slots/end     {id}: a person ends a slot early. Refused
 *                                with an agent's token (or an agent's claim):
 *                                an agent gives back only its own, over MCP.
 *                                Recorded in the slot log with who, and
 *                                in this install's audit, pointing there.
 *                                Ending a slot never stops the run that
 *                                held it; it frees the slot.
 *   POST /api/gate-slots/cancel  {id}: issue 585: the slot's owner (the
 *                                agent whose token asked for it) or a
 *                                person withdraws it; anyone else gets 403.
 *                                A queued ask is removed; a running one's
 *                                run is stopped (TERM, the grace, KILL) and
 *                                the slot frees once its group is gone. The
 *                                answer comes at once; the stop goes on.
 *                                Recorded `cancelled` in the slot log and
 *                                in this install's audit.
 */
import type * as http from "http";
import { cancelSlot, type StopDeps } from "../../shared/gates/cancel.js";
import type { Canceller } from "../../shared/gates/rules.js";
import type { GateStore } from "../../shared/gates/store.js";
import { gateView } from "../../shared/gates/view.js";
import { recordAction } from "./audit.js";
import { readBody, sendJson } from "./http-helpers.js";
import {
  agentPrincipalOf,
  auditActorOf,
  principalOf,
} from "./request-guard.js";

export const GATE_PATHS = [
  "/api/gate-slots",
  "/api/gate-slots/end",
  "/api/gate-slots/cancel",
] as const;

export const isGatePath = (p: string) =>
  (GATE_PATHS as readonly string[]).includes(p);

export interface GateRouteDeps {
  store: () => GateStore;
  /** Who a person is, in words, for the record. */
  title: string;
  /** This install's audit (recordAction); tests pass a recorder. */
  audit?: typeof recordAction;
  /** How a cancelled run is stopped; tests pass a stub. */
  stop?: StopDeps;
}

async function slotBody(
  req: http.IncomingMessage,
): Promise<{ id: string; release?: string }> {
  try {
    const raw = await readBody(req);
    const v = JSON.parse(raw.length > 4096 ? "{}" : raw || "{}") as {
      id?: unknown;
      release?: unknown;
    };
    return {
      id: typeof v.id === "string" ? v.id : "",
      ...(typeof v.release === "string" ? { release: v.release } : {}),
    };
  } catch {
    return { id: "" };
  }
}

const slotId = async (req: http.IncomingMessage) => (await slotBody(req)).id;

export async function handleGateRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  d: GateRouteDeps,
): Promise<void> {
  if (pathname === "/api/gate-slots") {
    if (req.method !== "GET")
      return sendJson(res, { ok: false, error: "GET only" }, 405);
    return sendJson(res, gateView(d.store()));
  }
  if (pathname === "/api/gate-slots/cancel") {
    if (req.method !== "POST")
      return sendJson(res, { ok: false, error: "POST only" }, 405);
    return cancelRoute(req, res, d);
  }
  if (pathname !== "/api/gate-slots/end")
    return sendJson(res, { ok: false, error: "no such route" }, 404);
  if (req.method !== "POST")
    return sendJson(res, { ok: false, error: "POST only" }, 405);
  if (agentPrincipalOf(req) || auditActorOf(req))
    return sendJson(
      res,
      {
        ok: false,
        code: "person_only",
        error: "only a person can end a slot early",
      },
      403,
    );
  const id = await slotId(req);
  if (!/^[a-z0-9-]{1,64}$/.test(id))
    return sendJson(res, { ok: false, error: "give the slot's id" }, 400);
  const by = `${d.title} · ${principalOf(req) ?? "a person in the browser"}`;
  const row = d.store().endEarly(id, by);
  if (!row) return sendJson(res, { ok: false, error: "no such slot" }, 404);
  // This install's own record says who did it, and points to the slot
  // log's entry (the machine's record of the slot).
  (d.audit ?? recordAction)(
    null,
    {
      verb: "gate-end",
      detail: `ended gate slot ${row.id} (${row.label}; ${row.who}) early; slot log ${d.store().eventsFile} at ${row.at}`,
    },
    principalOf(req),
  );
  return sendJson(res, { ok: true, slots: gateView(d.store()).slots });
}

async function cancelRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  d: GateRouteDeps,
): Promise<void> {
  const agent = agentPrincipalOf(req);
  // An unverified agent claim (headers only) is neither a person nor a
  // proven owner.
  const claimOnly = !agent && auditActorOf(req) !== null;
  const notYours = () =>
    sendJson(
      res,
      {
        ok: false,
        code: "not_yours",
        error:
          "only the agent that asked for this slot, or a person, can cancel it",
      },
      403,
    );
  if (claimOnly) return notYours();
  const { id, release } = await slotBody(req);
  const SLOT = /^[a-z0-9-]{1,64}$/;
  if (!SLOT.test(id) || (release !== undefined && !SLOT.test(release)))
    return sendJson(res, { ok: false, error: "give the slot's id" }, 400);
  const store = d.store();
  let by = `${d.title} · ${principalOf(req) ?? "a person in the browser"}`;
  let canceller: Canceller = agent ? { agent: agent.actor } : { person: true };
  if (release !== undefined) {
    // Idle flag: for a release run, by a person or the agent that asked
    // for that release run; only a slot flagged idle past the grace.
    const rel = store.peek(release);
    if (!rel || rel.kind !== "release")
      return sendJson(res, { ok: false, error: "no such release run" }, 404);
    if (agent && rel.actor !== agent.actor) return notYours();
    by += ` for release run ${rel.tag ?? rel.id}`;
    canceller = { release };
  }
  const r = cancelSlot(store, id, canceller, by, d.stop);
  if (!r.ok)
    return r.code === "not_yours"
      ? release !== undefined
        ? sendJson(
            res,
            {
              ok: false,
              code: "not_idle",
              error:
                "a release run cancels only a slot flagged idle for the grace",
            },
            403,
          )
        : notYours()
      : sendJson(res, { ok: false, error: "no such slot" }, 404);
  (d.audit ?? recordAction)(
    agent ? auditActorOf(req) : null,
    {
      verb: "gate-cancel",
      detail: `cancelled gate slot ${r.row.id} (${r.row.label}; ${r.row.who}) while ${r.was === "queued" ? "it waited" : "it ran"}${r.row.reason ? `, ${r.row.reason}` : ""}; slot log ${store.eventsFile} at ${r.row.at}`,
    },
    principalOf(req),
  );
  // The stop goes on here (Den's own process); it frees the slot when done.
  void r.done.catch(() => undefined);
  return sendJson(res, {
    ok: true,
    was: r.was,
    stopping: r.was === "running" && r.runPid !== undefined,
    slots: gateView(store).slots,
  });
}
