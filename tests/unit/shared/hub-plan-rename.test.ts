/**
 * Issue 167 (mock v6 A2): Rename asks Hub, never renames here. Den posts
 * one held change to Hub's POST /api/projects/plan with the install's
 * token: {changes: [{op: "rename", project: <Hub slug>, name}], reason}.
 * Hub answers {held, state, summary, url}; a person decides it in Hub.
 * A fake fetch plays Hub. Invented names only.
 */
import { describe, expect, it } from "@jest/globals";
import { HubCallError, hubPlanRename } from "../../../src/shared/hub.js";

const TOKEN = "hubi_TESTONLYabc987";

function fakeHub(status: number, body: unknown) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof globalThis.fetch;
  return { calls, fetch };
}

describe("hubPlanRename", () => {
  it("posts one rename to Hub's plan route, with the token; reads the held change", async () => {
    const h = fakeHub(201, {
      held: "held_1",
      state: "pending",
      summary: "Rename north-star to Polaris",
      url: "https://hub.example.test/acme/held/held_1",
    });
    const r = await hubPlanRename(
      "https://hub.example.test",
      TOKEN,
      { project: "north-star", name: "Polaris", reason: "asked in Den" },
      { fetch: h.fetch },
    );
    expect(r).toEqual({
      held: "held_1",
      state: "pending",
      summary: "Rename north-star to Polaris",
      url: "https://hub.example.test/acme/held/held_1",
    });
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].url).toBe("https://hub.example.test/api/projects/plan");
    expect(h.calls[0].init.method).toBe("POST");
    expect(
      (h.calls[0].init.headers as Record<string, string>).Authorization,
    ).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(String(h.calls[0].init.body))).toEqual({
      changes: [{ op: "rename", project: "north-star", name: "Polaris" }],
      reason: "asked in Den",
    });
  });

  it("a link that isn't http(s) is dropped; no held id is an error", async () => {
    const h = fakeHub(201, {
      held: "held_2",
      state: "pending",
      url: "javascript:x",
    });
    const r = await hubPlanRename(
      "https://hub.example.test",
      TOKEN,
      { project: "north-star", name: "Polaris", reason: "" },
      { fetch: h.fetch },
    );
    expect(r).toEqual({ held: "held_2", state: "pending" });
    const bad = fakeHub(201, { state: "pending" });
    await expect(
      hubPlanRename(
        "https://hub.example.test",
        TOKEN,
        { project: "north-star", name: "Polaris", reason: "" },
        { fetch: bad.fetch },
      ),
    ).rejects.toThrow(/held/);
  });

  it("Hub refuses: its words, as a HubCallError", async () => {
    const h = fakeHub(400, { error: "change 1: no such project" });
    const e = await hubPlanRename(
      "https://hub.example.test",
      TOKEN,
      { project: "gone", name: "Polaris", reason: "" },
      { fetch: h.fetch },
    ).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(HubCallError);
    expect((e as Error).message).toContain("no such project");
  });
});
