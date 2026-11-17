/**
 * Issue 172 S2: Web Push from Den's own crypto. The install's VAPID keys
 * (made once, 0600, the private key never in what is served), the
 * payload encrypted so only the device reads it, the subscriptions kept
 * (https, or a stub on this machine), a gone device dropped. A local stub
 * endpoint plays the device; no real push service.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import {
  PushSubscriptions,
  SUBSCRIPTIONS_FILE,
  VAPID_FILE,
  parseSubscription,
  pushAll,
  vapidKeys,
} from "../../../src/ui/server/web-push.js";
import { startPushStub, type PushStub } from "./helpers/push-stub.js";

let dir = "";
let stub: PushStub;
beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-push-"));
  stub = await startPushStub();
});
afterAll(async () => {
  await stub.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const msg = {
  title: "Acme",
  body: "Planner needs your permission",
  link: "/agents?project=north&agent=ag-1",
  tag: "t-1",
};

describe("issue 172 S2: Web Push", () => {
  it("VAPID keys: made once in the state dir, 0600; only the public key shows", () => {
    const a = vapidKeys(dir);
    const file = path.join(dir, VAPID_FILE);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(Buffer.from(a.publicKey, "base64url")).toHaveLength(65);
    expect(vapidKeys(dir).publicKey).toBe(a.publicKey);
    expect(JSON.stringify(a)).not.toContain(
      (JSON.parse(fs.readFileSync(file, "utf-8")) as { jwk: { d: string } }).jwk
        .d,
    );
  });

  it("a subscription: https or this machine's stub; keys of the right size", () => {
    const keys = stub.subscription.keys;
    expect(parseSubscription(stub.subscription)).toMatchObject({
      endpoint: stub.subscription.endpoint,
    });
    expect(
      parseSubscription({ endpoint: "https://push.example/x", keys }),
    ).not.toBeNull();
    expect(
      parseSubscription({ endpoint: "http://push.example/x", keys }),
    ).toBeNull();
    expect(
      parseSubscription({
        endpoint: "https://push.example/x",
        keys: { ...keys, auth: "AAAA" },
      }),
    ).toBeNull();
    expect(
      parseSubscription({ endpoint: "javascript:alert(1)", keys }),
    ).toBeNull();
  });

  it("a push reaches the device encrypted, signed by this install; a gone device is dropped", async () => {
    const subs = new PushSubscriptions(dir);
    subs.add(parseSubscription(stub.subscription)!);
    expect(fs.statSync(path.join(dir, SUBSCRIPTIONS_FILE)).mode & 0o777).toBe(
      0o600,
    );
    const o = {
      subs,
      keys: () => vapidKeys(dir),
      subject: "mailto:alerts@localhost",
      timeoutMs: 10_000,
      ttlSeconds: 600,
    };
    expect(await pushAll(msg, o)).toEqual([201]);
    const got = stub.received.at(-1)!;
    expect(got.headers["content-encoding"]).toBe("aes128gcm");
    expect(got.headers.ttl).toBe("600");
    expect(got.vapidOk).toBe(true);
    expect(got.claims).toMatchObject({
      aud: new URL(stub.subscription.endpoint).origin,
      sub: "mailto:alerts@localhost",
    });
    expect(JSON.parse(got.text!)).toEqual(msg);
    stub.answer = 410;
    expect(await pushAll(msg, o)).toEqual([410]);
    expect(subs.list()).toEqual([]);
    stub.answer = 201;
  });
});

describe("issue 172 S2: the service worker (public/den-sw.js)", () => {
  it("a push shows the alert; a click opens its page in a Den tab, or a new one", async () => {
    const src = fs.readFileSync(
      path.join(process.cwd(), "src/ui/server/public/den-sw.js"),
      "utf-8",
    );
    const on: Record<string, (e: unknown) => void> = {};
    const shown: { title: string; o: Record<string, unknown> }[] = [];
    const opened: string[] = [];
    const navigated: string[] = [];
    const tab = {
      url: "https://den.test/services",
      focus: async () => tab,
      navigate: async (u: string) => {
        navigated.push(u);
        return tab;
      },
    };
    let tabs: unknown[] = [];
    const self = {
      addEventListener: (k: string, f: (e: unknown) => void) => (on[k] = f),
      registration: {
        showNotification: async (title: string, o: Record<string, unknown>) =>
          void shown.push({ title, o }),
      },
      clients: {
        matchAll: async () => tabs,
        openWindow: async (u: string) => void opened.push(u),
      },
      location: { origin: "https://den.test" },
      skipWaiting: () => undefined,
    };
    vm.runInNewContext(src, { self, URL });
    const waits: Promise<unknown>[] = [];
    const ev = (extra: Record<string, unknown>) => ({
      waitUntil: (p: Promise<unknown>) => waits.push(p),
      ...extra,
    });
    on.push(ev({ data: { json: () => msg } }));
    await Promise.all(waits);
    expect(shown).toEqual([
      {
        title: "Acme",
        o: expect.objectContaining({
          body: msg.body,
          tag: "t-1",
          data: { link: msg.link },
        }),
      },
    ]);
    const close = () => undefined;
    on.notificationclick(
      ev({ notification: { data: { link: msg.link }, close } }),
    );
    await Promise.all(waits);
    expect(opened).toEqual([msg.link]);
    // A Den tab open: it comes up on the page.
    tabs = [tab];
    on.notificationclick(
      ev({ notification: { data: { link: "//evil.example/x" }, close } }),
    );
    await Promise.all(waits);
    expect(navigated).toEqual(["/agents"]);
  });
});
