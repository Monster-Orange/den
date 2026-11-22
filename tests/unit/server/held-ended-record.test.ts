/**
 * A held write Den once had never reads as a bare 404.
 *
 *  - A finished request (done, denied, expired, withdrawn, lost) reads
 *    back as that state with its decidedAt for a week: past the hour a
 *    settled one stays whole, and after a restart.
 *  - What is kept is small: id, actor, action, state, times, and the
 *    run's ok/error only; never its outputs (a token stays out of the file).
 *  - The asking agent's HTTP read (what approval_check calls) after a
 *    restart answers 200 with the state, never "No such request".
 *  - A pending request is in the person's Waiting (GET /api/notifications'
 *    `waiting`) the whole time it waits, and still after a restart.
 *
 * Temp dirs only; invented names only.
 */
import { afterAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as http from "http";
import type { AddressInfo } from "net";
import * as os from "os";
import * as path from "path";
import { NotificationStore } from "../../../src/shared/notifications.js";
import { handleApprovalRoutes } from "../../../src/ui/server/approval-routes.js";
import { ApprovalQueue } from "../../../src/ui/server/approvals.js";
import type { Attention } from "../../../src/ui/server/attention.js";
import { handleNotificationRoutes } from "../../../src/ui/server/notification-routes.js";
import {
  setPrincipal,
  type GuardResult,
  type Principal,
} from "../../../src/ui/server/request-guard.js";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const dirs: string[] = [];
const tmp = (p: string) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), p));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});

const ask = (name: string) => ({
  actor: "agent:north-planner",
  agent: "north-planner",
  action: "agent_create",
  args: { name },
  summary: `start the agent "${name}"`,
});

function setup(result: unknown = { ok: true }) {
  const file = path.join(tmp("den-ended-"), "held-writes.json");
  const clock = { t: 1_000_000 };
  const deps = {
    now: () => clock.t,
    file,
    knownAction: () => true,
    run: async () => result,
  };
  return { file, clock, deps, queue: () => new ApprovalQueue(deps) };
}

describe("a finished request reads back as its state, never 404", () => {
  it("done: past the hour and after a restart, with decidedAt and ok", async () => {
    const s = setup();
    const q = s.queue();
    const a = q.request(ask("helper"));
    s.clock.t += 5 * MIN;
    expect((await q.decide(a.id, "allow", "sess")).ok).toBe(true);
    const decidedAt = s.clock.t;

    s.clock.t += 2 * HOUR;
    expect(q.get(a.id)).toMatchObject({
      id: a.id,
      state: "done",
      decidedAt,
      result: { ok: true },
    });

    const again = s.queue();
    expect(again.get(a.id)).toMatchObject({
      id: a.id,
      actor: "agent:north-planner",
      action: "agent_create",
      state: "done",
      decidedAt,
      result: { ok: true },
    });
    // Not waiting again.
    expect(again.pending()).toEqual([]);

    // A week on, it is gone.
    s.clock.t += 8 * DAY;
    expect(s.queue().get(a.id)).toBeNull();
  });

  it("denied, expired, withdrawn and lost each read back after a restart", async () => {
    const s = setup();
    const q = s.queue();
    const denied = q.request(ask("one"));
    await q.decide(denied.id, "deny", "sess");
    const withdrawn = q.request(ask("two"));
    q.withdraw(withdrawn.id, "agent:north-planner");
    const expired = q.request({ ...ask("three"), ttlMs: 10 * MIN });
    s.clock.t += 11 * MIN;
    expect(q.get(expired.id)?.state).toBe("expired");

    // A restart in the middle of a run (the run never ends here): lost.
    const slow = new ApprovalQueue({
      ...s.deps,
      run: () => new Promise(() => {}),
    });
    const lost = slow.request(ask("four"));
    void slow.decide(lost.id, "allow", "sess");

    s.queue(); // the restart that cut it off
    s.clock.t += 3 * HOUR;
    const after = s.queue();
    expect(after.get(denied.id)).toMatchObject({ state: "denied" });
    expect(after.get(withdrawn.id)).toMatchObject({ state: "withdrawn" });
    expect(after.get(expired.id)).toMatchObject({
      state: "expired",
      decidedAt: expired.expiresAt,
    });
    expect(after.get(lost.id)).toMatchObject({ state: "lost" });
    expect(after.get(lost.id)?.lostBecause).toMatch(/restarted while it ran/);
    for (const id of [denied.id, withdrawn.id, expired.id, lost.id])
      expect(after.get(id)?.decidedAt).toEqual(expect.any(Number));
  });

  it("keeps the run's ok/error only: no outputs, no tokens in the file", async () => {
    const s = setup({
      ok: false,
      error: "the box did not answer",
      token: "tok-secret-value",
      forAsker: { token: "tok-secret-value" },
    });
    const q = s.queue();
    const a = q.request(ask("helper"));
    await q.decide(a.id, "allow", "sess");
    s.clock.t += 2 * HOUR;
    q.pending(); // prunes: the whole record goes, the small one stays
    const again = s.queue();
    expect(again.get(a.id)?.result).toEqual({
      ok: false,
      error: "the box did not answer",
    });
    expect(fs.readFileSync(s.file, "utf-8")).not.toContain("tok-secret-value");
  });

  it("a token in the run's error is redacted, stored and read back", async () => {
    // A token shape (invented): built at run time, never a literal.
    const tok = ["ghp", "_", "Z".repeat(36)].join("");
    const s = setup({ ok: false, error: `push refused for ${tok}` });
    const q = s.queue();
    const a = q.request(ask("helper"));
    await q.decide(a.id, "allow", "sess");
    s.clock.t += 2 * HOUR;
    q.pending();
    expect(fs.readFileSync(s.file, "utf-8")).not.toContain(tok);
    const err = (s.queue().get(a.id)?.result as { error?: string }).error;
    expect(err).toMatch(/^push refused for /);
    expect(err).not.toContain(tok);
  });

  it("deciding a finished one again says so, never 'No such request'", async () => {
    const s = setup();
    const q = s.queue();
    const a = q.request(ask("helper"));
    await q.decide(a.id, "allow", "sess");
    const again = s.queue();
    const r = await again.decide(a.id, "deny", "sess");
    expect(r).toMatchObject({ ok: false, code: "already_decided" });
    expect(again.withdraw(a.id, "agent:north-planner")).toMatchObject({
      ok: false,
      code: "already_decided",
    });
  });
});

/** The approval and notification routes over one queue, rebuilt on demand. */
async function serve(s: ReturnType<typeof setup>) {
  const box: { queue: ApprovalQueue } = { queue: s.queue() };
  const store = new NotificationStore(tmp("den-ended-store-"));
  const attention = {
    waitingNow: () => new Map(),
    waitingDetail: () => undefined,
  } as unknown as Attention;
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url!, "http://x").pathname;
    const agent = req.headers["x-test-agent"];
    const p = (
      typeof agent === "string"
        ? {
            kind: "agent",
            actor: `agent:${agent}`,
            workspace: "north",
            grants: [],
            session: { name: `acme-north:${agent}` },
          }
        : { kind: "person-browser", session: "sess-ended" }
    ) as Principal;
    setPrincipal(req, p);
    const guard = {
      ok: true,
      principal: p,
      via: "loopback",
      beyond: false,
      session: null,
    } as unknown as Extract<GuardResult, { ok: true }>;
    void (async () => {
      if (
        await handleNotificationRoutes(req, res, pathname, {
          store,
          attention,
          held: () => box.queue.pending(),
        })
      )
        return;
      if (
        await handleApprovalRoutes(req, res, pathname, guard, {
          queue: box.queue,
          actions: {},
          enabled: () => true,
        })
      )
        return;
      res.writeHead(404);
      res.end();
    })();
  });
  await new Promise<void>((r) => server.listen(0, "localhost", r));
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  return {
    box,
    base,
    close: () => new Promise((r) => server.close(r)),
  };
}

describe("over HTTP", () => {
  it("the asking agent's read after a restart is the state, not 404", async () => {
    const s = setup();
    const srv = await serve(s);
    try {
      const a = srv.box.queue.request(ask("helper"));
      await srv.box.queue.decide(a.id, "allow", "sess");
      srv.box.queue = s.queue(); // the restart
      const r = await fetch(`${srv.base}/api/approvals/${a.id}`, {
        headers: { "x-test-agent": "north-planner" },
      });
      expect(r.status).toBe(200);
      const b = (await r.json()) as Record<string, unknown>;
      expect(b).toMatchObject({
        id: a.id,
        state: "done",
        decidedAt: new Date(a.requestedAt).toISOString(),
        result: { ok: true },
      });
      expect(b.reason).toBe(
        `Done at ${new Date(a.requestedAt).toISOString()}. Den keeps how it ended and whether it worked, not what it returned.`,
      );
      // Another agent still can't read it.
      const other = await fetch(`${srv.base}/api/approvals/${a.id}`, {
        headers: { "x-test-agent": "quiet-scribe" },
      });
      expect(other.status).toBe(404);
    } finally {
      await srv.close();
    }
  });

  it("a pending request is in Waiting while it waits, and after a restart", async () => {
    const s = setup();
    const srv = await serve(s);
    try {
      const waiting = async () =>
        (
          (await (await fetch(`${srv.base}/api/notifications`)).json()) as {
            waiting: { kind?: string; id?: string }[];
          }
        ).waiting
          .filter((w) => w.kind === "allow")
          .map((w) => w.id);
      const a = srv.box.queue.request(ask("helper"));
      expect(await waiting()).toEqual([a.id]);
      // Past an agent's own 10-minute wait, and most of the person's day.
      s.clock.t += 11 * MIN;
      expect(await waiting()).toEqual([a.id]);
      s.clock.t += 20 * HOUR;
      expect(await waiting()).toEqual([a.id]);
      srv.box.queue = s.queue(); // the restart
      expect(await waiting()).toEqual([a.id]);
      // Its window over: it leaves Waiting, and reads as expired.
      s.clock.t += 4 * HOUR;
      expect(await waiting()).toEqual([]);
      expect(srv.box.queue.get(a.id)?.state).toBe("expired");
    } finally {
      await srv.close();
    }
  });
});
