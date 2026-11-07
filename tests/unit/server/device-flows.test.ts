/**
 * SEC-2a: the device flows the server runs for its pages (device-flows.ts).
 * A fake GitHub client, a hand-driven scheduler and clock: every poll is a
 * step the test takes, nothing waits for real.
 *
 *  - at most 3 pending at once (the 4th is `busy`); a pending one expires
 *    at GitHub's expiry, a finished one is forgotten a minute later;
 *  - a token is used for GET /user and dropped: it is never in a view;
 *  - an approved sign-in is claimed once.
 */
import { describe, expect, it } from "@jest/globals";
import {
  DeviceFlows,
  FINISHED_KEEP_MS,
  MAX_PENDING_FLOWS,
  type FlowPurpose,
} from "../../../src/ui/server/device-flows.js";
import type {
  GithubDeviceClient,
  GithubIdentity,
  PollResult,
} from "../../../src/shared/github-device.js";

const TOKEN = "ghu_fake_token_never_kept";

function rig(
  opts: {
    decide?: (p: FlowPurpose, id: GithubIdentity) => "ok" | "refused";
  } = {},
) {
  let now = 1_000_000;
  let n = 0;
  const timers: { fn: () => void; ms: number; live: boolean }[] = [];
  const answers = new Map<string, PollResult[]>();
  const users: GithubIdentity[] = [];
  const client: GithubDeviceClient = {
    start: async () => {
      n++;
      return {
        deviceCode: `dc-${n}`,
        userCode: `CODE-${n}`,
        expiresIn: 900,
        interval: 5,
      };
    },
    poll: async (_id, dc) => answers.get(dc)?.shift() ?? { kind: "pending" },
    user: async (token) => {
      if (token !== TOKEN) throw new Error("bad token");
      return users.shift() ?? { id: 1, login: "octo-owner" };
    },
  };
  const flows = new DeviceFlows({
    client,
    clientId: () => "Iv23liAcme",
    decide: opts.decide ?? ((_p, id) => (id.id === 4242 ? "ok" : "refused")),
    now: () => now,
    schedule: (fn, ms) => {
      const t = { fn, ms, live: true };
      timers.push(t);
      return () => (t.live = false);
    },
  });
  /** Run the scheduled polls due now (one round), and let them settle. */
  const tick = async () => {
    const due = timers.splice(0).filter((t) => t.live);
    for (const t of due) t.fn();
    for (let i = 0; i < 5; i++) await Promise.resolve();
    await new Promise((r) => setImmediate(r));
  };
  return {
    flows,
    timers,
    answers,
    users,
    tick,
    advance: (ms: number) => (now += ms),
  };
}

describe("DeviceFlows", () => {
  it("polls at GitHub's interval until approved; the owner's sign-in is ok and claimed once; no token in any view", async () => {
    const r = rig();
    const f = await r.flows.start("signin");
    if ("error" in f) throw new Error(f.error);
    expect(f).toMatchObject({
      state: "pending",
      userCode: "CODE-1",
      verificationUri: "https://github.com/login/device",
    });
    expect(r.timers.map((t) => t.ms)).toEqual([5000]);
    r.answers.set("dc-1", [
      { kind: "pending" },
      { kind: "token", token: TOKEN },
    ]);
    r.users.push({ id: 4242, login: "octo-owner" });
    await r.tick();
    expect(r.flows.get(f.id)?.state).toBe("pending");
    await r.tick();
    const done = r.flows.get(f.id);
    expect(done).toMatchObject({ state: "ok", login: "octo-owner" });
    expect(JSON.stringify(done).includes(TOKEN)).toBe(false);
    expect(JSON.stringify(done).includes("dc-1")).toBe(false);
    expect(r.flows.claim(f.id, "signin")).toEqual({
      id: 4242,
      login: "octo-owner",
    });
    expect(r.flows.claim(f.id, "signin")).toBeNull();
    expect(r.flows.get(f.id)).toBeNull();
  });

  it("another account is refused, by login, and can't be claimed", async () => {
    const r = rig();
    const f = await r.flows.start("signin");
    if ("error" in f) throw new Error(f.error);
    r.answers.set("dc-1", [{ kind: "token", token: TOKEN }]);
    r.users.push({ id: 7, login: "someone-else" });
    await r.tick();
    expect(r.flows.get(f.id)).toMatchObject({
      state: "refused",
      login: "someone-else",
    });
    expect(r.flows.claim(f.id, "signin")).toBeNull();
  });

  it("slow_down waits longer; denied, expired_token and repeated errors end it", async () => {
    const r = rig();
    const a = await r.flows.start("signin");
    if ("error" in a) throw new Error(a.error);
    r.answers.set("dc-1", [
      { kind: "slow_down" },
      { kind: "slow_down", interval: 20 },
      { kind: "denied" },
    ]);
    await r.tick();
    expect(r.timers.map((t) => t.ms)).toEqual([10_000]);
    await r.tick();
    expect(r.timers.map((t) => t.ms)).toEqual([20_000]);
    await r.tick();
    expect(r.flows.get(a.id)?.state).toBe("denied");

    const b = await r.flows.start("link");
    if ("error" in b) throw new Error(b.error);
    r.answers.set("dc-2", [{ kind: "expired" }]);
    await r.tick();
    expect(r.flows.get(b.id)?.state).toBe("expired");

    const c = await r.flows.start("signin");
    if ("error" in c) throw new Error(c.error);
    r.answers.set(
      "dc-3",
      Array.from({ length: 5 }, () => ({
        kind: "error" as const,
        message: "GitHub unreachable: boom",
      })),
    );
    for (let i = 0; i < 5; i++) await r.tick();
    expect(r.flows.get(c.id)).toMatchObject({
      state: "error",
      message: "GitHub unreachable: boom",
    });
  });

  it(`at most ${MAX_PENDING_FLOWS} pending at once: the next is busy until one ends`, async () => {
    const r = rig();
    const ids: string[] = [];
    for (let i = 0; i < MAX_PENDING_FLOWS; i++) {
      const f = await r.flows.start("signin");
      if ("error" in f) throw new Error(f.error);
      ids.push(f.id);
    }
    expect(await r.flows.start("signin")).toEqual({ error: "busy" });
    expect(await r.flows.start("link")).toEqual({ error: "busy" });
    r.answers.set("dc-1", [{ kind: "denied" }]);
    await r.tick();
    expect(r.flows.pending()).toBe(MAX_PENDING_FLOWS - 1);
    expect("error" in (await r.flows.start("signin"))).toBe(false);
  });

  it("a pending flow expires at GitHub's expiry; a finished one is forgotten a minute later", async () => {
    const r = rig();
    const f = await r.flows.start("signin");
    if ("error" in f) throw new Error(f.error);
    r.advance(900_000);
    expect(r.flows.get(f.id)?.state).toBe("expired");
    expect(r.flows.pending()).toBe(0);
    r.advance(FINISHED_KEEP_MS);
    expect(r.flows.get(f.id)).toBeNull();
  });

  it("no client id configured: no_client_id, and GitHub is never asked", async () => {
    let asked = false;
    const flows = new DeviceFlows({
      client: {
        start: async () => {
          asked = true;
          throw new Error("unreachable");
        },
        poll: async () => ({ kind: "pending" }),
        user: async () => ({ id: 1, login: "x" }),
      },
      clientId: () => "",
      decide: () => "ok",
    });
    expect(await flows.start("signin")).toEqual({ error: "no_client_id" });
    expect(asked).toBe(false);
  });

  it("a flow's purpose is part of its key: a link can't be read or claimed as a sign-in", async () => {
    const r = rig({ decide: () => "ok" });
    const f = await r.flows.start("link");
    if ("error" in f) throw new Error(f.error);
    r.answers.set("dc-1", [{ kind: "token", token: TOKEN }]);
    await r.tick();
    expect(r.flows.get(f.id, "signin")).toBeNull();
    expect(r.flows.claim(f.id, "signin")).toBeNull();
    expect(r.flows.get(f.id, "link")?.state).toBe("ok");
  });
});
