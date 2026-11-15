/**
 * 0.4.49 GATE-SLOT (den#144): the machine's gate slots on the web.
 *   GET  /api/gate-slots       who holds a slot and who waits, with the
 *                              machine's settings (gates/view.ts)
 *   POST /api/gate-slots/end   {id}: a person ends a slot early. Refused
 *                              with an agent's token (or an agent's claim):
 *                              an agent gives back only its own, over MCP.
 *                              Recorded in the slots' events with who.
 * Ending a slot never stops the run that held it; it frees the slot.
 */
import type * as http from "http";
import type { GateStore } from "../../shared/gates/store.js";
import { gateView } from "../../shared/gates/view.js";
import { readBody, sendJson } from "./http-helpers.js";
import {
  agentPrincipalOf,
  auditActorOf,
  principalOf,
} from "./request-guard.js";

export const GATE_PATHS = ["/api/gate-slots", "/api/gate-slots/end"] as const;

export const isGatePath = (p: string) =>
  (GATE_PATHS as readonly string[]).includes(p);

export interface GateRouteDeps {
  store: () => GateStore;
  /** Who a person is, in words, for the record. */
  title: string;
}

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
  let id = "";
  try {
    const raw = await readBody(req);
    const v = JSON.parse(raw.length > 4096 ? "{}" : raw || "{}") as {
      id?: unknown;
    };
    id = typeof v.id === "string" ? v.id : "";
  } catch {
    /* id stays empty */
  }
  if (!/^[a-z0-9-]{1,64}$/.test(id))
    return sendJson(res, { ok: false, error: "give the slot's id" }, 400);
  const by = `${d.title} · ${principalOf(req) ?? "a person in the browser"}`;
  if (!d.store().endEarly(id, by))
    return sendJson(res, { ok: false, error: "no such slot" }, 404);
  return sendJson(res, { ok: true, slots: gateView(d.store()).slots });
}
