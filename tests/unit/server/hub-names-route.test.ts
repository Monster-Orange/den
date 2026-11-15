/**
 * Issue 167 (mock v6 A6): /api/hub/names-check. GET: when Hub last
 * answered Den's check of its names, and when it last didn't. POST (Try
 * again): checks now, then answers the same.
 */
import { afterAll, describe, expect, it } from "@jest/globals";
import * as http from "http";
import type { AddressInfo } from "net";
import {
  hubNamesRoute,
  HUB_NAMES_PATH,
  type HubNamesRouteDeps,
} from "../../../src/ui/server/hub-names-routes.js";

const servers: http.Server[] = [];
afterAll(() => servers.forEach((s) => s.close()));

async function serve(d: HubNamesRouteDeps) {
  const s = http.createServer((req, res) => void hubNamesRoute(req, res, d));
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}${HUB_NAMES_PATH}`;
}

describe("/api/hub/names-check", () => {
  it("GET: the last check; nothing is asked of Hub", async () => {
    let runs = 0;
    const url = await serve({
      read: () => ({ okAt: "2026-11-15T10:00:00.000Z" }),
      refresh: async () => void runs++,
    });
    expect(await (await fetch(url)).json()).toEqual({
      ok: true,
      okAt: "2026-11-15T10:00:00.000Z",
    });
    expect(runs).toBe(0);
  });

  it("POST: checks now, then the check; a refresh that throws still answers", async () => {
    let check: { okAt?: string; failAt?: string } = {};
    const url = await serve({
      read: () => check,
      refresh: async () => {
        check = { failAt: "2026-11-15T10:12:00.000Z" };
        throw new Error("Hub didn't answer");
      },
    });
    const r = await fetch(url, { method: "POST" });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({
      ok: true,
      failAt: "2026-11-15T10:12:00.000Z",
    });
  });

  it("anything else: 405", async () => {
    const url = await serve({ read: () => ({}), refresh: async () => {} });
    expect((await fetch(url, { method: "DELETE" })).status).toBe(405);
  });
});
