/**
 * Issue 455: Den's address when something else holds its port.
 *
 *   GET  /api/den-identity?c=<challenge>   the identity probe's other end
 *        (den-identity.ts): { den: "identity", answer } for a challenge,
 *        400 otherwise. Sign-in free (the probe comes in through another
 *        proxy with no cookie); it tells nothing but that this is the Den
 *        holding web.secret.
 *   GET  /api/edge/address                 the last check (web.address_
 *        check_cache_seconds old at most, else a new one): the address
 *        people are given and how it answered, the one Den proved, what
 *        holds the port, the routes for another proxy, the edge's
 *        container and ports. The page banner and Edge read it.
 *   POST /api/edge/address/check           "Check again": a new check. When
 *        the address people are given now reaches Den through another
 *        proxy (Den's own is not running), edge.publish: false is set for
 *        the person ("set for you"), so Den stops trying to take the port.
 *        A person's only.
 *   POST /api/edge/address/take-over       "Take over": the port's holder is
 *        an old Den edge (it carries the edge's label): Den stops it and
 *        starts its own. A person's only; refused for anything else.
 */
import type * as http from "http";
import { identityBody } from "../../shared/den-identity.js";
import type {
  AddressState,
  PortState,
} from "../../shared/edge/address-check.js";

export interface EdgeNow {
  container: string;
  /** docker's state, or "absent" (not created). */
  state: string;
  /** Host ports when the edge publishes them (edge.publish), else null. */
  ports: PortState[] | null;
  publish: boolean;
}

export interface AddressRouteDeps {
  /** identityKey(web.secret), or null when there is none yet. */
  key: () => Buffer | null;
  /** A new check of the address. */
  check: () => Promise<AddressState>;
  /** The edge's container and ports now, or null (no edge configured). */
  edge: () => Promise<EdgeNow | null>;
  /** web.address_check_cache_seconds, in ms. */
  cacheMs: () => number;
  /** Sets edge.publish: false in user.yml. */
  setPublishOff: () => void;
  /** Stops `container` (an old Den edge) and starts Den's own edge. */
  takeOver: (container: string) => Promise<void>;
  isAgent: (req: http.IncomingMessage) => boolean;
  log?: (line: string) => void;
  sendJson: (res: http.ServerResponse, body: unknown, status?: number) => void;
}

export type AddressView = AddressState & {
  edge: EdgeNow | null;
  /** edge.publish was just set to false for the person. */
  publishSet?: boolean;
};

let last: { at: number; view: AddressView } | null = null;
let running: Promise<AddressView> | null = null;

/** Forget the last check (tests). */
export function resetAddressCache(): void {
  last = null;
  running = null;
}

async function fresh(d: AddressRouteDeps): Promise<AddressView> {
  running ??= (async () => {
    try {
      const [state, edge] = await Promise.all([d.check(), d.edge()]);
      const view: AddressView = { ...state, edge };
      last = { at: Date.now(), view };
      return view;
    } finally {
      running = null;
    }
  })();
  return running;
}

/** The last check when it is recent enough, else a new one. */
export async function addressView(d: AddressRouteDeps): Promise<AddressView> {
  if (last && Date.now() - last.at <= d.cacheMs()) return last.view;
  return fresh(d);
}

export async function handleAddressRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  d: AddressRouteDeps,
): Promise<boolean> {
  // DEN_IDENTITY_PATH (a test keeps the two the same).
  if (pathname === "/api/den-identity") {
    if (req.method !== "GET" && req.method !== "HEAD") return false;
    const c = new URL(req.url ?? "/", "http://den.invalid").searchParams.get(
      "c",
    );
    const key = d.key();
    const body = key ? identityBody(key, c) : null;
    res.writeHead(body ? 200 : 400, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify(body ?? { error: "no challenge" }));
    return true;
  }
  if (pathname === "/api/edge/address" && req.method === "GET") {
    try {
      d.sendJson(res, { ok: true, ...(await addressView(d)) });
    } catch (e) {
      d.sendJson(res, { ok: false, error: (e as Error).message }, 500);
    }
    return true;
  }
  if (
    (pathname === "/api/edge/address/check" ||
      pathname === "/api/edge/address/take-over") &&
    req.method === "POST"
  ) {
    if (d.isAgent(req)) {
      d.sendJson(
        res,
        { ok: false, error: "only a person checks or changes the edge here" },
        403,
      );
      return true;
    }
    try {
      if (pathname === "/api/edge/address/take-over") {
        const before = await fresh(d);
        const o = before.owner;
        if (!o || o.kind !== "container" || !o.denEdge) {
          d.sendJson(
            res,
            {
              ok: false,
              error:
                "what holds the port is not an old Den edge; Den takes over only its own",
            },
            409,
          );
          return true;
        }
        d.log?.(`edge: taking port ${before.port} over from ${o.name}`);
        await d.takeOver(o.name);
        d.sendJson(res, { ok: true, ...(await fresh(d)) });
        return true;
      }
      const view = await fresh(d);
      let publishSet = false;
      // Reached through another proxy while Den's own is down: Den's own
      // proxy stays off, set for the person.
      if (
        view.wantedAnswer === "den" &&
        view.edge &&
        view.edge.publish &&
        view.edge.state !== "running"
      ) {
        d.setPublishOff();
        publishSet = true;
        d.log?.(
          `edge: ${view.wanted} reaches Den through another proxy; edge.publish: false set`,
        );
        if (last)
          last.view = {
            ...last.view,
            edge: { ...view.edge, publish: false, ports: null },
          };
      }
      d.sendJson(res, {
        ok: true,
        ...(last?.view ?? view),
        ...(publishSet ? { publishSet } : {}),
      });
    } catch (e) {
      d.sendJson(res, { ok: false, error: (e as Error).message }, 500);
    }
    return true;
  }
  return false;
}
