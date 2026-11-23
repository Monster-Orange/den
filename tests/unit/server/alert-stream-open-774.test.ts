/**
 * Issue 774 row 7b: a page opens the alert stream only when this browser
 * has a push subscription, or once it subscribes. With no subscription
 * there is no push for the open tab to beat (the server keeps no device
 * for it), and the poll shows the alerts. So a page's load opens no
 * stream and writes nothing (R21: loading a page writes nothing).
 */
import { describe, expect, it } from "@jest/globals";
import { initAlerts } from "../../../src/ui/server/public/alerts.js";

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

function rig(o: { sub?: boolean } = {}) {
  const streams: string[] = [];
  const posts: string[] = [];
  const winListeners = new Map<string, (() => void)[]>();
  let sub = o.sub === true;
  const doc = {
    visibilityState: "visible",
    hasFocus: () => true,
    title: "Den",
    addEventListener: () => undefined,
    getElementById: () => null,
    querySelector: () => null,
  };
  class FakeES {
    onmessage: unknown = null;
    constructor(url: string) {
      streams.push(url);
    }
    close() {}
  }
  const win = {
    document: doc,
    localStorage: { getItem: () => null, setItem: () => undefined },
    location: { href: "https://den.example/services" },
    EventSource: FakeES,
    PushManager: function () {},
    Notification: Object.assign(function () {}, { permission: "granted" }),
    navigator: {
      serviceWorker: {
        getRegistration: async () => ({
          pushManager: {
            getSubscription: async () =>
              sub ? { endpoint: "https://push.example/b" } : null,
          },
        }),
      },
    },
    fetch: async (path: string, init?: { method?: string }) => {
      if (init?.method === "POST") posts.push(path);
      return { ok: false, json: async () => ({}) };
    },
    setInterval: () => 1,
    clearInterval: () => undefined,
    setTimeout: () => 1,
    addEventListener: (type: string, fn: () => void) => {
      winListeners.set(type, [...(winListeners.get(type) ?? []), fn]);
    },
  };
  const fire = (type: string) =>
    (winListeners.get(type) ?? []).forEach((fn) => fn());
  return {
    win: win as unknown as Window & typeof globalThis,
    streams,
    posts,
    fire,
    subscribe: () => void (sub = true),
  };
}

describe("774 row 7b: when a page opens the alert stream", () => {
  it("no push subscription: no stream and no write on load", async () => {
    const r = rig();
    initAlerts(r.win);
    await flush();
    expect(r.streams).toEqual([]);
    expect(r.posts).toEqual([]);
  });

  it("a push subscription: the stream opens", async () => {
    const r = rig({ sub: true });
    initAlerts(r.win);
    await flush();
    expect(r.streams).toEqual(["/api/alerts/stream"]);
  });

  it("subscribing on this page opens it then, once", async () => {
    const r = rig();
    initAlerts(r.win);
    await flush();
    r.subscribe();
    r.fire("den:push-on");
    r.fire("den:push-on");
    await flush();
    expect(r.streams).toEqual(["/api/alerts/stream"]);
  });
});
