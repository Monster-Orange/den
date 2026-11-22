/**
 * Issue 172 on the real server: an agent's wait (its own token says so)
 * and its write held for the person's Allow each put one alert in the
 * feed an open tab reads (GET /api/alerts), in the bell's words, linking
 * to the agent; never the tool line or the write's summary. An agent
 * can't read the person's alerts.
 * The demo distribution, the scripted PTY. Invented names only.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { denAuth } from "./helpers/den-auth.js";
import {
  startAgentsPageServer,
  type AgentsPageServer,
} from "./helpers/agents-page-server.js";
import { actorTokenOf } from "../../../src/shared/actor-token.js";
import { startPushStub } from "./helpers/push-stub.js";

let s: AgentsPageServer;
let token = "";

beforeAll(async () => {
  s = await startAgentsPageServer();
  const r = await fetch(`${s.base}/api/workspaces/north/agents`, {
    method: "POST",
    headers: { ...denAuth(s.stateDir), "content-type": "application/json" },
    body: JSON.stringify({ persona: "planner" }),
  });
  expect(r.status).toBe(200);
  token = actorTokenOf(s.made.at(-1)!.opts.env) ?? "";
  s.made.at(-1)!.emit("> ");
}, 90_000);
afterAll(async () => {
  await s?.stop();
});

async function call(
  method: string,
  p: string,
  body?: unknown,
  as: "person" | "agent" = "person",
) {
  const r = await fetch(`${s.base}${p}`, {
    method,
    headers: {
      ...(as === "person"
        ? denAuth(s.stateDir)
        : { authorization: `Bearer ${token}` }),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return {
    status: r.status,
    json: (await r.json().catch(() => ({}))) as Record<string, unknown>,
  };
}

type A = { body: string; link: string; why: string; title: string };

describe("issue 172: alerts on the real server", () => {
  it("a wait and a held write each alert once; an agent can't read them", async () => {
    const first = await call("GET", "/api/alerts");
    expect(first.status).toBe(200);
    expect(first.json.alerts).toEqual([]);
    const seq = first.json.seq as number;

    expect(
      (
        await call(
          "POST",
          "/api/agents/self/attention",
          {
            event: "waiting",
            why: "permission",
            what: "Bash: curl -H 'x-key: sk-live-9'",
            hooked: true,
          },
          "agent",
        )
      ).status,
    ).toBe(200);
    // The held write: the agent asks for the person's Allow.
    const held = await call(
      "POST",
      "/api/approvals",
      {
        action: "workspace_create",
        args: { name: "southward" },
        ask: true,
        note: "the person should pick",
      },
      "agent",
    );
    expect(held.status).toBe(202);

    const got = await call("GET", `/api/alerts?after=${seq}`);
    const alerts = got.json.alerts as A[];
    expect(alerts.map((a) => [a.why, a.body, a.link])).toEqual([
      [
        "permission",
        "planner needs your permission",
        "/agents?project=north&agent=planner",
      ],
      [
        "allow",
        "planner needs your Allow",
        "/agents?project=north&agent=planner",
      ],
    ]);
    const text = JSON.stringify(alerts);
    expect(text).not.toContain("sk-live");
    expect(text).not.toContain("southward");
    expect(alerts[0].title).toBeTruthy();
    // Issue 774: the project for the line under the heading; the count of
    // agents that need the person (one agent, two needs: one); the
    // switches the tab acts on, at their defaults.
    expect(alerts.map((a) => (a as A & { project: string }).project)).toEqual([
      "north",
      "north",
    ]);
    expect(got.json.count).toBe(1);
    expect(got.json.prefs).toEqual({
      desktop: true,
      sound: false,
      tab_count: true,
    });

    const byAgent = await call("GET", "/api/alerts", undefined, "agent");
    expect(byAgent.status).toBe(403);
  }, 60_000);

  it("S2: a subscribed device gets the alert by push, encrypted; unsubscribed, none", async () => {
    const stub = await startPushStub();
    try {
      const key = await call("GET", "/api/alerts/push-key");
      expect(key.status).toBe(200);
      expect(Buffer.from(String(key.json.publicKey), "base64url")).toHaveLength(
        65,
      );
      expect(
        (await call("GET", "/api/alerts/push-key", undefined, "agent")).status,
      ).toBe(403);
      // An agent can't add a device; a bad one is refused.
      expect(
        (
          await call(
            "POST",
            "/api/alerts/subscribe",
            { subscription: stub.subscription },
            "agent",
          )
        ).status,
      ).toBe(403);
      expect(
        (
          await call("POST", "/api/alerts/subscribe", {
            subscription: { endpoint: "http://push.example/x" },
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await call("POST", "/api/alerts/subscribe", {
            subscription: stub.subscription,
          })
        ).status,
      ).toBe(200);
      // A new wait (the last one answered first).
      await call(
        "POST",
        "/api/agents/self/attention",
        { event: "resumed", from: "session" },
        "agent",
      );
      await call(
        "POST",
        "/api/agents/self/attention",
        {
          event: "waiting",
          why: "asked",
          text: "Which code, 424242?",
          hooked: true,
        },
        "agent",
      );
      for (let i = 0; i < 100 && !stub.received.length; i++)
        await new Promise((r) => setTimeout(r, 100));
      expect(stub.received).toHaveLength(1);
      const got = stub.received[0];
      expect(got.vapidOk).toBe(true);
      // Issue 774: the words are the heading, the project under them.
      expect(JSON.parse(got.text!)).toMatchObject({
        title: "planner asked you",
        body: "north",
        link: "/agents?project=north&agent=planner",
      });
      expect(got.text).not.toContain("424242");
      expect(
        (
          await call("POST", "/api/alerts/unsubscribe", {
            endpoint: stub.subscription.endpoint,
          })
        ).status,
      ).toBe(200);
      await call(
        "POST",
        "/api/agents/self/attention",
        { event: "resumed", from: "session" },
        "agent",
      );
      await call(
        "POST",
        "/api/agents/self/attention",
        { event: "waiting", why: "permission", hooked: true },
        "agent",
      );
      await new Promise((r) => setTimeout(r, 1500));
      expect(stub.received).toHaveLength(1);
    } finally {
      await stub.close();
    }
  }, 60_000);

  it("issue 367: Settings' push limits reach the push; an agent can't set them", async () => {
    const stub = await startPushStub();
    try {
      expect(
        (
          await call(
            "POST",
            "/api/settings",
            { alerts: { push_ttl_seconds: 60 } },
            "agent",
          )
        ).status,
      ).toBe(403);
      expect(
        (
          await call("POST", "/api/settings", {
            alerts: { push_ttl_seconds: 60, push_timeout_seconds: 20 },
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await call("POST", "/api/settings", {
            alerts: { push_ttl_seconds: -1 },
          })
        ).status,
      ).toBe(400);
      expect((await call("GET", "/api/settings")).json.alerts).toMatchObject({
        push_ttl_seconds: 60,
        push_timeout_seconds: 20,
      });
      expect(
        (
          await call("POST", "/api/alerts/subscribe", {
            subscription: stub.subscription,
          })
        ).status,
      ).toBe(200);
      await call(
        "POST",
        "/api/agents/self/attention",
        { event: "resumed", from: "session" },
        "agent",
      );
      await call(
        "POST",
        "/api/agents/self/attention",
        { event: "waiting", why: "permission", hooked: true },
        "agent",
      );
      for (let i = 0; i < 100 && !stub.received.length; i++)
        await new Promise((r) => setTimeout(r, 100));
      expect(stub.received).toHaveLength(1);
      expect(stub.received[0].headers.ttl).toBe("60");
    } finally {
      await call("POST", "/api/alerts/unsubscribe", {
        endpoint: stub.subscription.endpoint,
      });
      await call("POST", "/api/settings", {
        alerts: { push_ttl_seconds: null, push_timeout_seconds: null },
      });
      await call(
        "POST",
        "/api/agents/self/attention",
        { event: "resumed", from: "session" },
        "agent",
      );
      await stub.close();
    }
  }, 60_000);

  it("the person's devices: listed without endpoints, a test alert reaches each and says how it went, one can be forgotten", async () => {
    const stub = await startPushStub();
    type D = {
      id: string;
      service: string;
      device: string;
      at: string;
      status?: number;
      reached?: boolean;
      gone?: boolean;
    };
    const devices = async () =>
      (await call("GET", "/api/alerts/devices")).json.devices as D[];
    try {
      expect(
        (await call("GET", "/api/alerts/devices", undefined, "agent")).status,
      ).toBe(403);
      expect(await devices()).toEqual([]);
      // None yet: the test says so, nothing goes out.
      const none = await call("POST", "/api/alerts/test", {});
      expect(none.status).toBe(200);
      expect(none.json.devices).toEqual([]);
      const r = await fetch(`${s.base}/api/alerts/subscribe`, {
        method: "POST",
        headers: {
          ...denAuth(s.stateDir),
          "content-type": "application/json",
          "user-agent":
            "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15",
        },
        body: JSON.stringify({ subscription: stub.subscription }),
      });
      expect(r.status).toBe(200);
      const list = await devices();
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({ service: "other", device: "iPhone" });
      expect(list[0].id).toMatch(/^[0-9a-f]{16}$/);
      expect(Number.isNaN(Date.parse(list[0].at))).toBe(false);
      expect(JSON.stringify(list)).not.toContain(stub.subscription.endpoint);
      expect(JSON.stringify(list)).not.toContain(stub.subscription.keys.auth);
      // An agent can't send one.
      expect((await call("POST", "/api/alerts/test", {}, "agent")).status).toBe(
        403,
      );
      const t = await call("POST", "/api/alerts/test", {});
      expect(t.status).toBe(200);
      expect(t.json.devices).toEqual([
        { ...list[0], status: 201, reached: true, gone: false },
      ]);
      expect(stub.received).toHaveLength(1);
      expect(stub.received[0].vapidOk).toBe(true);
      expect(JSON.parse(stub.received[0].text!)).toMatchObject({
        body: "Test alert: this device gets alerts when an agent needs you.",
        link: "/settings#notifications",
      });
      // The push service refuses: not reached, still kept.
      stub.answer = 500;
      const bad = await call("POST", "/api/alerts/test", {});
      expect((bad.json.devices as D[])[0]).toMatchObject({
        status: 500,
        reached: false,
        gone: false,
      });
      expect(await devices()).toHaveLength(1);
      stub.answer = 201;
      // Forget it by its id: an agent can't; the person can.
      expect(
        (await call("POST", "/api/alerts/forget", { id: list[0].id }, "agent"))
          .status,
      ).toBe(403);
      const f = await call("POST", "/api/alerts/forget", { id: list[0].id });
      expect(f.json).toMatchObject({ ok: true, removed: true });
      expect(await devices()).toEqual([]);
      // Gone at the push service: the test says so and drops it.
      await call("POST", "/api/alerts/subscribe", {
        subscription: stub.subscription,
      });
      stub.answer = 410;
      const gone = await call("POST", "/api/alerts/test", {});
      expect((gone.json.devices as D[])[0]).toMatchObject({
        status: 410,
        reached: false,
        gone: true,
      });
      expect(await devices()).toEqual([]);
    } finally {
      stub.answer = 201;
      await call("POST", "/api/alerts/unsubscribe", {
        endpoint: stub.subscription.endpoint,
      });
      await stub.close();
    }
  }, 60_000);
});
