/**
 * Issue 172: the person's devices that get push, at the routes. The list
 * names each device (its push service, what it is, when it was added) and
 * never carries an endpoint or its keys; Send a test alert pushes to each
 * and says, per device, whether it reached it (gone: dropped); Forget
 * stops one by its id. A local stub plays the device; no real push
 * service. The real server's run is alerts.integration.test.ts.
 */
import fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import {
  handleNotificationRoutes,
  type NotificationRouteDeps,
} from "../../../src/ui/server/notification-routes.js";
import {
  PushSubscriptions,
  pushEach,
  vapidKeys,
} from "../../../src/ui/server/web-push.js";
import { startPushStub, type PushStub } from "./helpers/push-stub.js";

let dir = "";
let stub: PushStub;
let server: http.Server;
let base = "";

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-alert-devices-"));
  stub = await startPushStub();
  const subs = new PushSubscriptions(dir);
  const deps = {
    push: {
      subs,
      publicKey: () => vapidKeys(dir).publicKey,
      test: () =>
        pushEach(
          { title: "Acme", body: "test", link: "/settings", tag: "t" },
          {
            subs,
            keys: () => vapidKeys(dir),
            subject: "mailto:alerts@localhost",
            timeoutMs: 10_000,
            ttlSeconds: 60,
          },
        ),
    },
  } as unknown as NotificationRouteDeps;
  server = http.createServer((req, res) => {
    const p = new URL(req.url ?? "/", "http://x").pathname;
    void handleNotificationRoutes(req, res, p, deps).then((done) => {
      if (!done) {
        res.writeHead(404);
        res.end();
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await stub.close();
  await new Promise<void>((r) => server.close(() => r()));
  fs.rmSync(dir, { recursive: true, force: true });
});

async function call(method: string, p: string, body?: unknown, ua?: string) {
  const r = await fetch(`${base}${p}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(ua ? { "user-agent": ua } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return {
    status: r.status,
    json: (await r.json().catch(() => ({}))) as Record<string, unknown>,
  };
}

type D = {
  id: string;
  service: string;
  device: string;
  at: string;
  status?: number;
  reached?: boolean;
  gone?: boolean;
};

describe("issue 172: the devices that get push", () => {
  it("listed without endpoints; a test alert says per device how it went; forget one", async () => {
    const devices = async () =>
      (await call("GET", "/api/alerts/devices")).json.devices as D[];
    expect(await devices()).toEqual([]);
    expect((await call("POST", "/api/alerts/test", {})).json.devices).toEqual(
      [],
    );
    expect(stub.received).toHaveLength(0);
    await call(
      "POST",
      "/api/alerts/subscribe",
      { subscription: stub.subscription },
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)",
    );
    const list = await devices();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ service: "other", device: "iPhone" });
    expect(list[0].id).toMatch(/^[0-9a-f]{16}$/);
    expect(JSON.stringify(list)).not.toContain(stub.subscription.endpoint);
    expect(JSON.stringify(list)).not.toContain(stub.subscription.keys.auth);

    const ok = await call("POST", "/api/alerts/test", {});
    expect(ok.json.devices).toEqual([
      { ...list[0], status: 201, reached: true, gone: false },
    ]);
    expect(stub.received).toHaveLength(1);
    expect(stub.received[0].vapidOk).toBe(true);

    stub.answer = 500;
    const bad = await call("POST", "/api/alerts/test", {});
    expect((bad.json.devices as D[])[0]).toMatchObject({
      status: 500,
      reached: false,
      gone: false,
    });
    expect(await devices()).toHaveLength(1);
    stub.answer = 201;

    expect(
      (await call("POST", "/api/alerts/forget", { id: "0000000000000000" }))
        .json,
    ).toMatchObject({ ok: true, removed: false });
    expect(
      (await call("POST", "/api/alerts/forget", { id: list[0].id })).json,
    ).toMatchObject({ ok: true, removed: true });
    expect(await devices()).toEqual([]);

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
    stub.answer = 201;
  });
});
