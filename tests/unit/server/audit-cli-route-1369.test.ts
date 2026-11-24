/**
 * Issue 1369: POST /api/audit/cli reads at most 8 KB of a body, so a
 * credential's holder can't send a body of any size into the server's
 * memory; past it, the entry is refused, never parsed or recorded.
 */
import { describe, expect, it } from "@jest/globals";
import type * as http from "http";
import { Readable } from "stream";
import { cliAuditRequest } from "../../../src/ui/server/audit-cli-route.js";

const req = (body: string | Buffer[]) =>
  Readable.from(
    typeof body === "string" ? [Buffer.from(body)] : body,
  ) as unknown as http.IncomingMessage;

const deps = () => {
  const recorded: unknown[] = [];
  const remembered: string[] = [];
  return {
    recorded,
    remembered,
    d: {
      principal: "agent:a1",
      actor: "agent:a1",
      budget: () => true,
      record: (actor: string | null, row: unknown, principal: string) => {
        recorded.push({ actor, row, principal });
        return { ts: "2026-01-01T00:00:00.000Z" };
      },
      remember: (id: string) => remembered.push(id),
    },
  };
};

describe("issue 1369: POST /api/audit/cli", () => {
  it("an entry is recorded as its credential says, and its queued copy's id remembered", async () => {
    const t = deps();
    const r = await cliAuditRequest(
      req(
        JSON.stringify({
          verb: "agents",
          detail: "ok",
          principal: "person:someone",
          id: "000000000000001-1-000000000-00000000",
        }),
      ),
      t.d,
    );
    expect(r.status).toBe(200);
    expect(t.recorded).toEqual([
      {
        actor: "agent:a1",
        row: { verb: "agents", detail: "ok" },
        principal: "agent:a1",
      },
    ]);
    expect(t.remembered).toEqual(["000000000000001-1-000000000-00000000"]);
  });

  it("a body past 8 KB is refused unparsed, however large, and nothing recorded", async () => {
    const t = deps();
    const chunk = Buffer.alloc(64 * 1024, 0x61);
    const r = await cliAuditRequest(
      req(Array.from({ length: 64 }, () => chunk)),
      t.d,
    );
    expect(r.status).toBe(413);
    expect(t.recorded).toEqual([]);
  });

  it("no credential: 401; past the hour's budget: 429; not an entry: 400", async () => {
    const t = deps();
    expect(
      (await cliAuditRequest(req("{}"), { ...t.d, principal: null })).status,
    ).toBe(401);
    expect(
      (
        await cliAuditRequest(req('{"verb":"agents","detail":"x"}'), {
          ...t.d,
          budget: () => false,
        })
      ).status,
    ).toBe(429);
    expect((await cliAuditRequest(req('{"verb":"other"}'), t.d)).status).toBe(
      400,
    );
    expect(t.recorded).toEqual([]);
  });
});
