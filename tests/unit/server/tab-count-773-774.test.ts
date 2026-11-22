/**
 * Issue 774 + 773: the count in the tab reads the same "needs you" list as
 * the Agents page and the rail (mock 774 v3, notes for the developers): a
 * running agent stopped on a permission, a question or an Allow. One rule,
 * isNeedsYouRow, for the rail's count and the tab's.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import type * as http from "node:http";
import { describe, expect, it } from "@jest/globals";
import { isNeedsYouRow } from "../../../src/ui/server/session-routes.js";
import { handleNotificationRoutes } from "../../../src/ui/server/notification-routes.js";
import { NotificationStore } from "../../../src/shared/notifications.js";
import { setPrincipal } from "../../../src/ui/server/request-guard.js";

const row = (extra: Record<string, unknown>) => ({
  kind: "agent",
  agent: "planner",
  state: "running",
  ...extra,
});

describe("one rule for needs you (the page, the rail, the tab)", () => {
  it("a running agent on a permission, a question or an Allow needs you", () => {
    expect(
      isNeedsYouRow(row({ waiting: true, waitingWhy: "permission" })),
    ).toBe(true);
    expect(isNeedsYouRow(row({ waiting: true, waitingWhy: "asked" }))).toBe(
      true,
    );
    // A held Allow: waiting, with no hook reason.
    expect(isNeedsYouRow(row({ waiting: true }))).toBe(true);
  });

  it("an idle agent, a stopped one or a terminal does not", () => {
    expect(isNeedsYouRow(row({ waiting: true, waitingWhy: "input" }))).toBe(
      false,
    );
    expect(isNeedsYouRow(row({ waiting: false }))).toBe(false);
    // A stopped agent with a held Allow is in Stopped, not Needs you.
    expect(isNeedsYouRow(row({ waiting: true, state: "stopped" }))).toBe(false);
    expect(
      isNeedsYouRow({ kind: "shell", state: "running", waiting: true }),
    ).toBe(false);
  });

  it("the rail's count and the tab's both use it", () => {
    const src = (f: string) =>
      fs.readFileSync(path.join("src", "ui", "server", f), "utf-8");
    expect(src("session-routes.ts")).toMatch(
      /if \(isNeedsYouRow\(r\)\) needs \+= 1/,
    );
    const fn = /function needsYouCount\(\)[^{]*\{([\s\S]*?)\n\}/.exec(
      src("index.ts"),
    );
    expect(fn?.[1]).toContain("needsYouNow(");
    expect(fn?.[1]).not.toContain("needsYouAgents(");
  });
});

describe("GET /api/alerts: the count may come from an async source", () => {
  it("awaits it", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tab-"));
    try {
      const r = new PassThrough() as unknown as http.IncomingMessage &
        PassThrough;
      Object.assign(r, { method: "GET", url: "/api/alerts", headers: {} });
      setPrincipal(r, { kind: "person", actor: "person:a" });
      r.end("");
      const out = { body: "" };
      const s = {
        headersSent: false,
        setHeader: () => undefined,
        writeHead: () => s,
        end: (b?: string) => void (out.body = b ?? ""),
      } as unknown as http.ServerResponse;
      await handleNotificationRoutes(r, s, "/api/alerts", {
        store: new NotificationStore(dir),
        needsYou: async () => 2,
      } as never);
      expect(JSON.parse(out.body).count).toBe(2);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
