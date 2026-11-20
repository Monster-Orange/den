/**
 * Issue 144 GATE-SLOT: the machine's gate slots on the web.
 *   GET  /api/gate-slots       who holds a slot and who waits, with the
 *                              machine's settings (gates/view.ts)
 *   POST /api/gate-slots/end   {id}: a person ends a slot early. Refused
 *                              with an agent's token (or an agent's claim):
 *                              an agent gives back only its own, over MCP.
 *                              Recorded in the slot log with who, and
 *                              in this install's audit, pointing there.
 * Ending a slot never stops the run that held it; it frees the slot.
 *
 * Issue 621: a CI job in a runner VM (no Den there, no process here) takes
 * a slot with a gate-only runner token (shared/gates/runner-tokens.ts).
 * request-guard.ts lets that token reach these three routes only:
 *   POST /api/gate-slots/ask      {kind, estimate_minutes, label?,
 *                                 wait_seconds?, priority?, reason?}: waits
 *                                 up to wait_seconds (at most the lapse
 *                                 time) for the slot, then answers granted,
 *                                 or its place in line. Issue 739:
 *                                 priority "release" with a reason goes
 *                                 ahead of its kind's plain waiting runs
 *                                 (issue 715's rules), if the machine lets
 *                                 runners ask (priority_runners).
 *   POST /api/gate-slots/renew    {id}: renews the lease (holding or
 *                                 waiting) and says where it stands: the poll
 *   POST /api/gate-slots/release  {id}: gives it back
 * The same queue, kinds and slot log as a local holder; it holds by lease,
 * not by a process, and a lease not renewed in time is taken back.
 * A person lists and revokes the tokens (Settings):
 *   GET  /api/gate-slots/runners          names and dates, never a token
 *   POST /api/gate-slots/runners/revoke   {id}
 * A token is made only by the held write gate_runner_token_create, on the
 * person's Allow (gateRunnerTokenOp).
 */
import type * as http from "http";
import {
  expectedEnd,
  expectedStart,
  type GateEntry,
} from "../../shared/gates/rules.js";
import {
  RUNNER_NAME_RE,
  type RunnerTokens,
} from "../../shared/gates/runner-tokens.js";
import {
  GateFullError,
  GatePriorityRefused,
  type GateStore,
} from "../../shared/gates/store.js";
import { gateView } from "../../shared/gates/view.js";
import { recordAction } from "./audit.js";
import type { HeldOp } from "./held-actions.js";
import { readBodyCapped, sendJson } from "./http-helpers.js";
import {
  agentPrincipalOf,
  auditActorOf,
  principalOf,
  runnerPrincipalOf,
} from "./request-guard.js";

export const GATE_PATHS = [
  "/api/gate-slots",
  "/api/gate-slots/end",
  "/api/gate-slots/ask",
  "/api/gate-slots/renew",
  "/api/gate-slots/release",
  "/api/gate-slots/runners",
  "/api/gate-slots/runners/revoke",
] as const;

export const isGatePath = (p: string) =>
  (GATE_PATHS as readonly string[]).includes(p);

export interface GateRouteDeps {
  store: () => GateStore;
  /** Who a person is, in words, for the record. */
  title: string;
  /** This install's audit (recordAction); tests pass a recorder. */
  audit?: typeof recordAction;
  /** Issue 621: this install's runner tokens. */
  runners?: () => RunnerTokens;
  /** Issue 621: how often a waiting ask looks again, ms (default 1000). */
  pollMs?: number;
}

/** The largest body a gate route reads, bytes. */
const BODY_MAX = 4096;

/** A JSON body, {} when it isn't one; null when it is over BODY_MAX. */
async function bodyOf(
  req: http.IncomingMessage,
): Promise<Record<string, unknown> | null> {
  try {
    const raw = await readBodyCapped(req, BODY_MAX);
    if (raw === null) return null;
    const v: unknown = JSON.parse(raw || "{}");
    return v && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

const TOO_BIG = { ok: false, error: `the body is at most ${BODY_MAX} bytes` };

/** C0 and C1 control characters (after whitespace became plain spaces). */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;

/** Issue 621: asks waiting on an answer, per runner token (this process). */
const ASKING = new Map<string, number>();

/**
 * Issue 621: a person revokes a runner token. Its slots, held or waiting,
 * are taken back at once (the slot log says so), and an ask in flight
 * answers 401 at its next look.
 */
export function revokeRunner(
  d: Pick<GateRouteDeps, "store" | "runners">,
  id: unknown,
) {
  const v = d.runners?.().revoke(id) ?? null;
  if (v) d.store().takeBackToken(v.id);
  return v;
}

const REVOKED = {
  ok: false,
  code: "token_revoked",
  error: "This runner token was revoked. Ask the person for a new one.",
};

/** Whether the runner's token is still live (unset: no store to ask). */
const tokenLive = (d: GateRouteDeps, id: string) =>
  d.runners ? d.runners().live(id) : true;

/** How many cheap looks between two locked renews of a waiting ask. */
const LOOKS_PER_RENEW = 5;

/** Issue 621: where a runner's slot stands, as the runner reads it. */
function standing(store: GateStore, e: GateEntry): Record<string, unknown> {
  const all = store.list();
  const s = store.settings();
  const now = all.find((x) => x.id === e.id) ?? e;
  return {
    ok: true,
    id: now.id,
    kind: now.kind,
    granted: !!now.grantedAt,
    // The machine's priority settings and clock (issue 739).
    place: store.place(now.id),
    ...(now.grantedAt
      ? { expected_end: new Date(expectedEnd(now)).toISOString() }
      : {
          expected_start: new Date(
            expectedStart(all, now.id, Date.now()),
          ).toISOString(),
        }),
    ...(now.remote ? { lease_until: now.remote.leaseUntil } : {}),
    renew_seconds: s.remoteRenewSeconds,
    lapse_seconds: s.remoteLapseSeconds,
  };
}

const NO_SLOT = {
  ok: false,
  code: "no_slot",
  error:
    "No such slot for this runner: it was released, ended early, or its lease lapsed. Ask again.",
};

async function askAndWait(
  res: http.ServerResponse,
  d: GateRouteDeps,
  store: GateStore,
  runner: { id: string; name: string },
  a: {
    kind: "browser" | "cpu";
    label: string;
    est: number;
    waitMs: number;
    reason?: string;
  },
): Promise<void> {
  let e: GateEntry | null;
  try {
    e = store.askRemote({
      kind: a.kind,
      who: `${d.title} · runner ${runner.name}`,
      label: a.label,
      estimateMin: a.est,
      runner: runner.name,
      tokenId: runner.id,
      ...(a.reason !== undefined ? { priority: { reason: a.reason } } : {}),
    });
  } catch (err) {
    if (err instanceof GatePriorityRefused)
      return sendJson(
        res,
        { ok: false, code: "priority_refused", error: err.message },
        403,
      );
    if (err instanceof GateFullError)
      return sendJson(
        res,
        { ok: false, code: "too_many_slots", error: err.message },
        429,
      );
    throw err;
  }
  // Waits a bounded time for the slot, keeping the lease while it does.
  // Each tick is a cheap look at the slot's own file; a locked renew (the
  // queue settled) comes every few looks. The token is checked each tick:
  // a revoke ends the wait with 401, never a grant.
  const until = Date.now() + a.waitMs;
  let closed = false;
  res.on("close", () => (closed = true));
  let looks = 0;
  while (e && !e.grantedAt && Date.now() < until && !closed) {
    await new Promise((r) => setTimeout(r, d.pollMs ?? 1000));
    if (closed || !tokenLive(d, runner.id)) break;
    looks++;
    e =
      looks % LOOKS_PER_RENEW === 0
        ? store.renew(e.id, runner.id)
        : (store.peek(e.id) ?? store.renew(e.id, runner.id));
  }
  if (!tokenLive(d, runner.id)) {
    store.takeBackToken(runner.id);
    if (!closed) sendJson(res, REVOKED, 401);
    return;
  }
  // A caller that hung up never hears the slot's id: give it back.
  if (closed) {
    if (e) store.releaseRemote(e.id, runner.id);
    return;
  }
  if (!e) return sendJson(res, NO_SLOT, 410);
  // A cheap look may be stale: renew under the lock before answering.
  const now = store.renew(e.id, runner.id);
  if (!now) return sendJson(res, NO_SLOT, 410);
  return sendJson(res, standing(store, now));
}

async function handleRunnerRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  d: GateRouteDeps,
): Promise<void> {
  if (req.method !== "POST")
    return sendJson(res, { ok: false, error: "POST only" }, 405);
  const runner = runnerPrincipalOf(req);
  if (!runner)
    return sendJson(
      res,
      {
        ok: false,
        code: "runner_only",
        error:
          "These routes take a gate runner token. On this machine, use `gate run`.",
      },
      403,
    );
  const store = d.store();
  const body = await bodyOf(req);
  if (!body) return sendJson(res, TOO_BIG, 400);
  if (pathname === "/api/gate-slots/ask") {
    const kind = body.kind;
    if (kind !== "browser" && kind !== "cpu")
      return sendJson(res, { ok: false, error: "kind is browser or cpu" }, 400);
    const est = body.estimate_minutes;
    if (
      typeof est !== "number" ||
      !Number.isFinite(est) ||
      est <= 0 ||
      est > 24 * 60
    )
      return sendJson(
        res,
        {
          ok: false,
          error:
            "estimate_minutes is a number of minutes, above 0, at most 1440",
        },
        400,
      );
    const label =
      typeof body.label === "string" && body.label.trim()
        ? body.label
            .replace(/\s+/g, " ")
            .replace(CONTROL, "")
            .trim()
            .slice(0, 120) || "CI job"
        : "CI job";
    // Issue 739: release priority, as `gate run --priority release`.
    let reason: string | undefined;
    if (body.priority !== undefined) {
      if (body.priority !== "release")
        return sendJson(
          res,
          { ok: false, error: 'priority is "release", or left out' },
          400,
        );
      reason =
        typeof body.reason === "string"
          ? body.reason.replace(/\s+/g, " ").replace(CONTROL, "").trim()
          : "";
      if (!reason)
        return sendJson(
          res,
          {
            ok: false,
            code: "reason_required",
            error:
              "priority release needs a reason: who waits on this run, and why",
          },
          400,
        );
    }
    const waitRaw = body.wait_seconds ?? 20;
    if (typeof waitRaw !== "number" || !Number.isFinite(waitRaw) || waitRaw < 0)
      return sendJson(
        res,
        { ok: false, error: "wait_seconds is a number of seconds, 0 or more" },
        400,
      );
    // At most the lapse time (a Setting): the caller hears back in time.
    const waitMs =
      Math.min(waitRaw, store.settings().remoteLapseSeconds) * 1000;
    // Asks waiting on an answer are capped per token (a Setting).
    const s = store.settings();
    const asking = ASKING.get(runner.id) ?? 0;
    if (asking >= s.remoteMaxAsks)
      return sendJson(
        res,
        {
          ok: false,
          code: "too_many_asks",
          error: `this runner has ${s.remoteMaxAsks} asks waiting already; wait for one to answer, or raise the limit in Settings`,
        },
        429,
      );
    ASKING.set(runner.id, asking + 1);
    try {
      return await askAndWait(res, d, store, runner, {
        kind,
        label,
        est,
        waitMs,
        ...(reason !== undefined ? { reason } : {}),
      });
    } finally {
      const n = (ASKING.get(runner.id) ?? 1) - 1;
      if (n > 0) ASKING.set(runner.id, n);
      else ASKING.delete(runner.id);
    }
  }
  const id = typeof body.id === "string" ? body.id : "";
  if (!/^[a-z0-9-]{1,64}$/.test(id))
    return sendJson(res, { ok: false, error: "give the slot's id" }, 400);
  if (pathname === "/api/gate-slots/renew") {
    const e = store.renew(id, runner.id);
    if (!e) return sendJson(res, NO_SLOT, 404);
    return sendJson(res, standing(store, e));
  }
  if (!store.releaseRemote(id, runner.id)) return sendJson(res, NO_SLOT, 404);
  return sendJson(res, { ok: true, released: true });
}

async function handleRunnerTokens(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  d: GateRouteDeps,
): Promise<void> {
  if (agentPrincipalOf(req) || auditActorOf(req) || runnerPrincipalOf(req))
    return sendJson(
      res,
      {
        ok: false,
        code: "person_only",
        error: "only a person lists or revokes runner tokens",
      },
      403,
    );
  // A signed-out page (a plain read on loopback passes the checks) is
  // told to sign in, as for any person's data.
  if (!principalOf(req)?.startsWith("person:"))
    return sendJson(
      res,
      {
        ok: false,
        code: "signin_required",
        error: "sign in to see the runner tokens",
      },
      401,
    );
  if (!d.runners)
    return sendJson(res, { ok: false, error: "no runner tokens here" }, 404);
  if (pathname === "/api/gate-slots/runners") {
    if (req.method !== "GET")
      return sendJson(res, { ok: false, error: "GET only" }, 405);
    return sendJson(res, { ok: true, runners: d.runners().list() });
  }
  if (req.method !== "POST")
    return sendJson(res, { ok: false, error: "POST only" }, 405);
  const body = await bodyOf(req);
  const v = revokeRunner(d, body?.id);
  if (!v)
    return sendJson(res, { ok: false, error: "no such runner token" }, 404);
  (d.audit ?? recordAction)(
    null,
    {
      verb: "gate-runner",
      detail: `runner token ${v.id} (${v.name}) revoked`,
    },
    principalOf(req),
  );
  return sendJson(res, { ok: true, runners: d.runners().list() });
}

/**
 * Issue 621: the held write gate_runner_token_create. An agent (or a
 * person) asks; only the person's own Allow makes the token (critical:
 * it touches a secret). The token goes back once, to the asker only
 * (the run's forAsker part, approval-routes.ts): never to the Allow's
 * answer, the bell, a log or the activity trail. Deny makes nothing.
 */
export function gateRunnerTokenOp(d: {
  runners: () => RunnerTokens;
  audit?: typeof recordAction;
}): HeldOp {
  return {
    check(a, who) {
      const name = typeof a.name === "string" ? a.name.trim() : "";
      if (!RUNNER_NAME_RE.test(name))
        return {
          ok: false,
          error:
            "give name: the CI runner's name (letters, digits, dot, dash or underscore; at most 64)",
        };
      if (d.runners().named(name))
        return {
          ok: false,
          error: `the runner ${name} has a token already: revoke it in Settings first`,
        };
      const asker = who?.agent ?? "";
      const once: { key: string; vars?: Record<string, string> } = asker
        ? {
            key: "ap.det.gate_runner_token_create.onceAgent",
            vars: { agent: asker },
          }
        : { key: "ap.det.gate_runner_token_create.once" };
      // Critical by its name (a token) and its placement (approval-policy.ts).
      return {
        ok: true,
        personOnly: true,
        args: { name },
        summary: `make a gate-only token for the CI runner "${name}"`,
        params: { name },
        details: [
          `Makes a token for the CI runner "${name}". It can only ask for, renew and give back gate slots on this machine: nothing else in Den.`,
          asker
            ? `The token goes once to ${asker}, the agent that asked, and is never shown again. Den keeps only its hash.`
            : "The token goes once to whoever asked, and is never shown again. Den keeps only its hash.",
          "You can revoke it any time in Settings, under CI runner tokens.",
        ],
        detailKeys: [
          { key: "ap.det.gate_runner_token_create.reach", vars: { name } },
          once,
          { key: "ap.det.gate_runner_token_create.revoke" },
        ],
      };
    },
    run(a, asked) {
      let made: ReturnType<RunnerTokens["create"]>;
      try {
        made = d.runners().create(String(a.name));
      } catch (e) {
        return Promise.resolve({ ok: false, error: (e as Error).message });
      }
      const { token, view } = made;
      (d.audit ?? recordAction)(null, {
        verb: "gate-runner",
        detail: `runner token ${view.id} made for ${view.name}; asked by ${asked?.agent ? `agent:${asked.agent}` : "a person"}, allowed by ${asked?.decidedBy ?? "the person"}`,
      });
      return Promise.resolve({ ok: true, ...view, forAsker: { token } });
    },
  };
}

export async function handleGateRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  d: GateRouteDeps,
): Promise<void> {
  // The runner token's routes (request-guard.ts RUNNER_ROUTES).
  if (
    pathname === "/api/gate-slots/ask" ||
    pathname === "/api/gate-slots/renew" ||
    pathname === "/api/gate-slots/release"
  )
    return handleRunnerRoute(req, res, pathname, d);
  if (
    pathname === "/api/gate-slots/runners" ||
    pathname === "/api/gate-slots/runners/revoke"
  )
    return handleRunnerTokens(req, res, pathname, d);
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
  const body = await bodyOf(req);
  const id = typeof body?.id === "string" ? body.id : "";
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
