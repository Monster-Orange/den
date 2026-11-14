import { describe, expect, it } from "@jest/globals";
import {
  createRequestLedger,
  validRequestId,
} from "../../../src/ui/server/request-ledger.js";

// BUSY-1: Try again resends the same request id; Den runs the action once.
describe("request ledger (BUSY-1)", () => {
  const owner = "s:abc";

  it("accepts ids of 8 to 64 letters, digits and dashes only", () => {
    expect(validRequestId("7f3a9c1e")).toBe(true);
    expect(validRequestId("0b9e4f5a-1c2d-4e3f-8a9b-0c1d2e3f4a5b")).toBe(true);
    expect(validRequestId("short")).toBe(false);
    expect(validRequestId("x".repeat(65))).toBe(false);
    expect(validRequestId("has space1")).toBe(false);
    expect(validRequestId(undefined)).toBe(false);
  });

  it("runs a request once: a repeat while running waits, a later repeat replays", async () => {
    const l = createRequestLedger({ ttlMs: () => 60_000 });
    const first = l.begin(owner, "req-00001");
    expect(first.kind).toBe("new");
    const again = l.begin(owner, "req-00001");
    expect(again.kind).toBe("wait");
    expect(l.status(owner, "req-00001")).toEqual({ state: "running" });
    if (first.kind !== "new" || again.kind !== "wait") throw new Error("kind");
    first.finish({
      status: 201,
      contentType: "application/json",
      body: Buffer.from('{"ok":true}'),
    });
    const waited = await again.done;
    expect(waited.status).toBe(201);
    expect(waited.body?.toString()).toBe('{"ok":true}');
    const later = l.begin(owner, "req-00001");
    expect(later.kind).toBe("wait");
    if (later.kind === "wait") expect((await later.done).status).toBe(201);
    expect(l.status(owner, "req-00001")).toEqual({
      state: "done",
      status: 201,
    });
  });

  it("keeps each signed-in person's ids apart", () => {
    const l = createRequestLedger({ ttlMs: () => 60_000 });
    l.begin(owner, "req-00002");
    expect(l.begin("s:other", "req-00002").kind).toBe("new");
    expect(l.status("s:other", "req-00003")).toEqual({ state: "unknown" });
  });

  it("forgets a request after the memory time (a setting)", () => {
    let t = 1_000;
    const l = createRequestLedger({ ttlMs: () => 5_000, now: () => t });
    const a = l.begin(owner, "req-00004");
    if (a.kind !== "new") throw new Error("kind");
    a.finish({ status: 200 });
    t += 4_999;
    expect(l.status(owner, "req-00004").state).toBe("done");
    t += 2;
    expect(l.status(owner, "req-00004")).toEqual({ state: "unknown" });
    expect(l.begin(owner, "req-00004").kind).toBe("new");
  });

  it("never forgets a request that is still running", () => {
    let t = 1_000;
    const l = createRequestLedger({ ttlMs: () => 5_000, now: () => t });
    l.begin(owner, "req-00005");
    t += 60_000;
    expect(l.status(owner, "req-00005")).toEqual({ state: "running" });
  });

  it("keeps at most maxEntries finished requests, oldest out first", () => {
    const l = createRequestLedger({ ttlMs: () => 60_000, maxEntries: 2 });
    for (const id of ["req-0000a", "req-0000b", "req-0000c"]) {
      const b = l.begin(owner, id);
      if (b.kind === "new") b.finish({ status: 200 });
    }
    expect(l.status(owner, "req-0000a").state).toBe("unknown");
    expect(l.status(owner, "req-0000c").state).toBe("done");
  });
});
