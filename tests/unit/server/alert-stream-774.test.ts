/**
 * Issue 774 row 7b, the tab's side: an open tab holds the alert stream,
 * says which device it is (its push subscription's endpoint, in a POST
 * body) and whether it shows, shows a streamed alert itself (the push to
 * this device waits for it), and acks it. One alert shows once per
 * browser, whether the poll or the stream brings it first.
 */
import { describe, expect, it } from "@jest/globals";
import { alertStream } from "../../../src/ui/server/public/alerts.js";

const ENDPOINT = "https://push.example/this-browser";

function rig(o: { visible?: boolean; focus?: boolean; sub?: boolean } = {}) {
  const store = new Map<string, string>();
  const posts: [string, Record<string, unknown>][] = [];
  const shown: string[] = [];
  const played: string[] = [];
  const doc = {
    visibilityState: o.visible === false ? "hidden" : "visible",
    hasFocus: () => o.focus !== false,
  };
  const win = {
    document: doc,
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    },
    location: { href: "https://den.example/services" },
    Notification: Object.assign(function () {}, { permission: "granted" }),
    navigator: {
      serviceWorker: {
        getRegistration: async () => ({
          pushManager: {
            getSubscription: async () =>
              o.sub === false ? null : { endpoint: ENDPOINT },
          },
        }),
      },
    },
  } as unknown as Window;
  const s = alertStream(win, {
    prefs: () => ({ desktop: true, sound: true, tab_count: true }),
    deps: {
      show: (a: { id: string }) => void shown.push(a.id),
      play: (k: string) => void played.push(k),
      wait: async () => undefined,
    },
    post: async (p: string, b: Record<string, unknown>) => {
      posts.push([p, b]);
      return true;
    },
  });
  return { win, doc, s, posts, shown, played };
}

const alert = (id: string) => ({
  id,
  why: "permission",
  body: "planner needs your permission",
  project: "north",
  agent: "planner",
  link: "/agents?project=north&agent=planner",
});

describe("774 row 7b: the tab's alert stream", () => {
  it("the tab event: presence names this browser's device in the body, and whether it shows", async () => {
    const r = rig();
    await r.s.onEvent({ type: "tab", tab: "T1" });
    expect(r.posts).toEqual([
      [
        "/api/alerts/presence",
        { tab: "T1", endpoint: ENDPOINT, visible: true },
      ],
    ]);
  });

  it("no push subscription: presence claims no device", async () => {
    const r = rig({ sub: false });
    await r.s.onEvent({ type: "tab", tab: "T1" });
    expect(r.posts[0][1]).toEqual({ tab: "T1", endpoint: null, visible: true });
  });

  it("going hidden says so at once", async () => {
    const r = rig();
    await r.s.onEvent({ type: "tab", tab: "T1" });
    (r.doc as { visibilityState: string }).visibilityState = "hidden";
    await r.s.presence();
    expect(r.posts.at(-1)?.[1]).toMatchObject({ tab: "T1", visible: false });
  });

  it("a streamed alert is shown here (not left to the push) and acked", async () => {
    const r = rig({ focus: false });
    await r.s.onEvent({ type: "tab", tab: "T1" });
    await r.s.onEvent({ type: "alert", alert: alert("a1") });
    expect(r.shown).toEqual(["a1"]);
    expect(r.played).toEqual(["needs"]);
    expect(r.posts.at(-1)).toEqual([
      "/api/alerts/ack",
      { tab: "T1", id: "a1" },
    ]);
  });

  it("another tab of this browser showed it: no second show, no ack (that tab acks)", async () => {
    const r = rig({ focus: false });
    await r.s.onEvent({ type: "tab", tab: "T1" });
    r.win.localStorage.setItem("den-alerts-shown", JSON.stringify(["a1"]));
    await r.s.onEvent({ type: "alert", alert: alert("a1") });
    expect(r.shown).toEqual([]);
    expect(r.posts.some(([p]) => p === "/api/alerts/ack")).toBe(false);
  });

  it("drop: another tab acked it, so this tab never shows it (stream or poll)", async () => {
    const r = rig({ focus: false });
    await r.s.onEvent({ type: "tab", tab: "T1" });
    await r.s.onEvent({ type: "drop", id: "a2" });
    await r.s.onEvent({ type: "alert", alert: alert("a2") });
    expect(r.shown).toEqual([]);
  });

  it("nothing shown or played, and the person not looking: no ack, so the push still goes", async () => {
    const r = rig({ focus: false });
    const quiet = alertStream(r.win, {
      prefs: () => ({ desktop: false, sound: false, tab_count: true }),
      deps: {
        show: () => undefined,
        play: () => undefined,
        wait: async () => undefined,
      },
      post: async (p: string, b: Record<string, unknown>) => {
        r.posts.push([p, b]);
        return true;
      },
    });
    await quiet.onEvent({ type: "tab", tab: "T2" });
    await quiet.onEvent({ type: "alert", alert: alert("a3") });
    expect(r.posts.some(([p]) => p === "/api/alerts/ack")).toBe(false);
  });

  it("before the tab event, an alert or presence posts nothing", async () => {
    const r = rig();
    await r.s.presence();
    await r.s.onEvent({ type: "alert", alert: alert("a4") });
    expect(r.posts).toEqual([]);
  });
});
