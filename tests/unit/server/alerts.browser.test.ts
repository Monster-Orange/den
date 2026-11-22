/**
 * Issue 172 S1 on the real path: an open Den tab in the background shows
 * a desktop notification when an agent starts to need its person, in the
 * bell's words, and a click opens the agent. A tab in front shows none
 * (the bell and the Allow dialog say it). Settings › Notifications ›
 * Desktop alerts asks the browser, and saves alerts.desktop.
 * The browser's Notification is a stub (the permission granted by the
 * test); nothing reaches a real notification service. Invented names.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import type { Browser, Page } from "playwright";
import { denAuth } from "./helpers/den-auth.js";
import { signInPage } from "./helpers/signed-in.js";
import {
  startAgentsPageServer,
  type AgentsPageServer,
} from "./helpers/agents-page-server.js";
import { actorTokenOf } from "../../../src/shared/actor-token.js";
import { closeBrowserSuite } from "../../browser-teardown.js";
import { startPushStub, type PushStub } from "./helpers/push-stub.js";
import { launchBrowser } from "../helpers/browser.js";

let browser: Browser | null = null;
let s: AgentsPageServer | null = null;
let token = "";
let latest = "";
const errors: string[] = [];

beforeAll(async () => {
  try {
    const { chromium } = await import("playwright");
    browser = await launchBrowser(chromium);
  } catch (err) {
    if (process.env.DEN_SKIP_BROWSER_TESTS === "1") return;
    throw err;
  }
  s = await startAgentsPageServer();
  latest =
    (
      (await (await fetch(`${s.base}/api/changelog`)).json()) as {
        version: string;
      }[]
    )[0]?.version ?? "";
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
  await closeBrowserSuite({ browsers: [browser], servers: [s] });
});

const skip = () => !browser;

const asAgent = (p: string, body: unknown) =>
  fetch(`${s!.base}${p}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

/**
 * A page whose Notification is a stub: `permission` to start with, each
 * one shown kept in window.__shown; `front`: whether the tab has focus.
 */
async function open(
  path: string,
  o: {
    permission: string;
    front: boolean;
    /** S2: the device's subscription a stubbed PushManager hands out. */
    sub?: PushStub["subscription"];
  },
): Promise<Page> {
  const ctx = await browser!.newContext({
    viewport: { width: 1280, height: 860 },
    reducedMotion: "reduce",
  });
  await ctx.addInitScript(
    ({ v, permission, front, sub }) => {
      try {
        for (const k of ["den-changelog-seen", "acme-changelog-seen"])
          localStorage.setItem(k, v);
      } catch {
        /* none */
      }
      const w = window as unknown as Record<string, unknown>;
      const shown: Record<string, unknown>[] = [];
      w.__shown = shown;
      w.__asked = 0;
      class FakeNotification {
        static permission = permission;
        static async requestPermission() {
          w.__asked = (w.__asked as number) + 1;
          FakeNotification.permission = "granted";
          return "granted";
        }
        title: string;
        body: string;
        tag: string;
        onclick: null | (() => void) = null;
        constructor(title: string, o: { body?: string; tag?: string }) {
          this.title = title;
          this.body = o?.body ?? "";
          this.tag = o?.tag ?? "";
          shown.push(this as unknown as Record<string, unknown>);
        }
        close() {}
      }
      w.Notification = FakeNotification;
      Document.prototype.hasFocus = () => front;
      if (sub) {
        // S2: a service worker and PushManager that never reach a real
        // push service: the subscription is the test's local stub.
        let subscribed = false;
        const subscription = {
          endpoint: sub.endpoint,
          toJSON: () => sub,
          unsubscribe: async () => {
            subscribed = false;
            return true;
          },
        };
        const pushManager = {
          getSubscription: async () => (subscribed ? subscription : null),
          subscribe: async (opt: { applicationServerKey: Uint8Array }) => {
            w.__appKey = opt.applicationServerKey.length;
            subscribed = true;
            return subscription;
          },
        };
        const reg = { pushManager };
        w.PushManager = function PushManager() {};
        Object.defineProperty(navigator, "serviceWorker", {
          configurable: true,
          value: {
            register: async (url: string) => {
              w.__swUrl = url;
              return reg;
            },
            ready: Promise.resolve(reg),
            getRegistration: async () => reg,
          },
        });
      }
    },
    { v: latest, ...o, sub: o.sub ?? null },
  );
  const p = await ctx.newPage();
  p.on("pageerror", (e) => errors.push(e.message));
  await signInPage(p, s!.stateDir, s!.base, path);
  return p;
}

/** The tab read the feed once (it starts from now). */
const firstRead = (p: Page) =>
  p.waitForResponse((r) => r.url().includes("/api/alerts"), {
    timeout: 15_000,
  });

describe("issue 172 S1: desktop alerts from an open tab", () => {
  it("in the background: a new wait shows one notification; a click opens the agent", async () => {
    if (skip()) return;
    const p = await open("/services", { permission: "granted", front: false });
    await firstRead(p);
    expect(
      (
        await asAgent("/api/agents/self/attention", {
          event: "waiting",
          why: "permission",
          what: "Bash: echo sk-live-77",
          hooked: true,
        })
      ).status,
    ).toBe(200);
    await p.waitForFunction(
      () => (window as unknown as { __shown: unknown[] }).__shown.length > 0,
      null,
      { timeout: 20_000 },
    );
    const shown = await p.evaluate(() =>
      (
        window as unknown as {
          __shown: { title: string; body: string; tag: string }[];
        }
      ).__shown.map((n) => ({ title: n.title, body: n.body, tag: n.tag })),
    );
    expect(shown).toHaveLength(1);
    expect(shown[0].body).toBe("planner needs your permission");
    expect(shown[0].title).toBeTruthy();
    expect(shown[0].tag).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.stringify(shown)).not.toContain("sk-live");
    await p.evaluate(() =>
      (
        window as unknown as { __shown: { onclick: () => void }[] }
      ).__shown[0].onclick(),
    );
    await p.waitForURL(/\/agents\?project=north&agent=planner$/, {
      timeout: 15_000,
    });
    // Answered: the next need can alert again.
    await asAgent("/api/agents/self/attention", {
      event: "resumed",
      from: "session",
    });
    await p.context().close();
  }, 90_000);

  it("in front: none (the bell and the Allow dialog say it)", async () => {
    if (skip()) return;
    const p = await open("/services", { permission: "granted", front: true });
    await firstRead(p);
    const r = await asAgent("/api/approvals", {
      action: "workspace_create",
      args: { name: "eastward" },
      ask: true,
      note: "pick a name",
    });
    expect(r.status).toBe(202);
    // Two reads after it: still nothing shown.
    for (let i = 0; i < 2; i++)
      await p.waitForResponse((x) => x.url().includes("/api/alerts?after="), {
        timeout: 15_000,
      });
    expect(
      await p.evaluate(
        () => (window as unknown as { __shown: unknown[] }).__shown.length,
      ),
    ).toBe(0);
    // The person says no, so the next page has no dialog in front.
    await p.locator("#den-ap-deny").click();
    await p.locator("#den-ap-dlg").waitFor({ state: "hidden" });
    await p.context().close();
  }, 90_000);

  it("Settings › Notifications › Desktop alerts asks the browser and saves", async () => {
    if (skip()) return;
    const p = await open("/settings#notifications", {
      permission: "default",
      front: true,
    });
    await p.click('#set-nav a[data-cat="notifications"]');
    const sw = p.locator("#setting-notifications-desktop input.set-check");
    await sw.waitFor();
    // Not allowed in this browser yet: off.
    expect(await sw.isChecked()).toBe(false);
    await sw.click();
    await p.waitForFunction(
      () => (window as unknown as { __asked: number }).__asked === 1,
    );
    await p.waitForFunction(
      () =>
        (
          document.querySelector(
            "#setting-notifications-desktop input.set-check",
          ) as HTMLInputElement | null
        )?.checked === true,
      null,
      { timeout: 10_000 },
    );
    expect(await s!.settingsGet()).toMatchObject({
      alerts: { desktop: true },
    });
    // Quiet hours: a start alone says it needs an end.
    await p
      .locator("#setting-notifications-quiet_from select")
      .selectOption("22:00");
    await p
      .locator(".set-warn", { hasText: "need a start and an end" })
      .waitFor();
    await p
      .locator("#setting-notifications-quiet_to select")
      .selectOption("07:00");
    await p
      .locator(".set-warn", { hasText: "need a start and an end" })
      .waitFor({ state: "detached" });
    expect(await s!.settingsGet()).toMatchObject({
      alerts: { quiet_from: "22:00", quiet_to: "07:00" },
    });
    await s!.settings({ alerts: { quiet_from: null, quiet_to: null } });
    expect(errors).toEqual([]);
    await p.context().close();
  }, 90_000);

  it("S2: Alerts on this device by push subscribes it; the next need reaches it by push, not as a tab's notification", async () => {
    if (skip()) return;
    const stub = await startPushStub();
    try {
      const p = await open("/settings#notifications", {
        permission: "default",
        front: false,
        sub: stub.subscription,
      });
      await p.click('#set-nav a[data-cat="notifications"]');
      const sw = p.locator("#set-phone-push");
      await sw.waitFor();
      expect(await sw.isChecked()).toBe(false);
      await sw.click();
      // The click checks the box at once; done is the server keeping this
      // device (the switch drawn again, enabled, from its subscription).
      await p.waitForFunction(
        () => {
          const w = window as unknown as Record<string, unknown>;
          const el = document.getElementById(
            "set-phone-push",
          ) as HTMLInputElement | null;
          return (
            w.__appKey !== undefined && el?.checked === true && !el.disabled
          );
        },
        null,
        { timeout: 15_000 },
      );
      for (
        let i = 0;
        i < 100 &&
        ((await s!.settingsGet()).alerts as { phone?: boolean } | undefined)
          ?.phone !== true;
        i++
      )
        await p.waitForTimeout(100);
      expect(
        await p.evaluate(() => {
          const w = window as unknown as Record<string, unknown>;
          return [w.__swUrl, w.__appKey, w.__asked];
        }),
      ).toEqual([
        // The version stamp: a new Den brings its worker up to date.
        expect.stringMatching(/^\/den-sw\.js(\?v=.+)?$/),
        65,
        1,
      ]);
      expect(await s!.settingsGet()).toMatchObject({ alerts: { phone: true } });
      await firstRead(p);
      expect(
        (
          await asAgent("/api/agents/self/attention", {
            event: "waiting",
            why: "permission",
            hooked: true,
          })
        ).status,
      ).toBe(200);
      for (let i = 0; i < 100 && !stub.received.length; i++)
        await p.waitForTimeout(100);
      expect(stub.received).toHaveLength(1);
      expect(stub.received[0].vapidOk).toBe(true);
      expect(JSON.parse(stub.received[0].text!)).toMatchObject({
        body: "planner needs your permission",
        link: "/agents?project=north&agent=planner",
      });
      // The tab leaves it to the push: no second notification.
      for (let i = 0; i < 2; i++)
        await p.waitForResponse((x) => x.url().includes("/api/alerts?after="), {
          timeout: 15_000,
        });
      expect(
        await p.evaluate(
          () => (window as unknown as { __shown: unknown[] }).__shown.length,
        ),
      ).toBe(0);
      // Off on this device: it stops; the server forgets it.
      const forgot = p.waitForResponse((x) =>
        x.url().endsWith("/api/alerts/unsubscribe"),
      );
      await sw.click();
      expect((await forgot).status()).toBe(200);
      await p.waitForFunction(
        () =>
          (document.getElementById("set-phone-push") as HTMLInputElement | null)
            ?.checked === false,
      );
      await asAgent("/api/agents/self/attention", {
        event: "resumed",
        from: "session",
      });
      await asAgent("/api/agents/self/attention", {
        event: "waiting",
        why: "permission",
        hooked: true,
      });
      await p.waitForTimeout(1500);
      expect(stub.received).toHaveLength(1);
      await asAgent("/api/agents/self/attention", {
        event: "resumed",
        from: "session",
      });
      expect(errors).toEqual([]);
      await p.context().close();
    } finally {
      await stub.close();
    }
  }, 120_000);

  it("Devices that get push: this device shows up; Send a test alert reaches it and says so; Forget removes it", async () => {
    if (skip()) return;
    const stub = await startPushStub();
    try {
      const p = await open("/settings#notifications", {
        permission: "granted",
        front: true,
        sub: stub.subscription,
      });
      await p.click('#set-nav a[data-cat="notifications"]');
      const row = p.locator("#setting-notifications-push_devices");
      // None yet: it says how to add a phone, and the test waits for one.
      await row.locator("#set-push-none").waitFor();
      expect(await row.locator("#set-push-test").isDisabled()).toBe(true);
      await p.locator("#set-phone-push").click();
      const device = row.locator("[data-device]");
      await device.waitFor({ timeout: 15_000 });
      expect(await device.count()).toBe(1);
      expect(await device.getAttribute("data-service")).toBe("other");
      expect(await device.getAttribute("data-this")).not.toBeNull();
      await row.locator("#set-push-test").click();
      await row
        .locator("[data-test-result]", {
          hasText: "Sent: its push service took it.",
        })
        .waitFor({ timeout: 15_000 });
      expect(stub.received).toHaveLength(1);
      expect(JSON.parse(stub.received[0].text!)).toMatchObject({
        body: "Test alert: this device gets alerts when an agent needs you.",
        link: "/settings#notifications",
      });
      // The phone is lost: Forget it here.
      await device.locator("[data-forget]").click();
      await row.locator("#set-push-none").waitFor({ timeout: 15_000 });
      expect(
        (
          (await (
            await fetch(`${s!.base}/api/alerts/devices`, {
              headers: denAuth(s!.stateDir),
            })
          ).json()) as { devices: unknown[] }
        ).devices,
      ).toEqual([]);
      expect(errors).toEqual([]);
      await p.context().close();
    } finally {
      await stub.close();
    }
  }, 120_000);

  it("S2: the manifest and the service worker are served", async () => {
    if (skip()) return;
    const m = await fetch(`${s!.base}/manifest.webmanifest`, {
      headers: denAuth(s!.stateDir),
    });
    expect(m.headers.get("content-type")).toContain("manifest+json");
    expect(await m.json()).toMatchObject({ display: "standalone", scope: "/" });
    const w = await fetch(`${s!.base}/den-sw.js`, {
      headers: denAuth(s!.stateDir),
    });
    expect(w.status).toBe(200);
    expect(await w.text()).toContain('addEventListener("push"');
  });
});
