/**
 * P0-D2: Den gets an approval (Hub's kind "approve", a held decision, or,
 * until Hub sends kinds, its "approved vN of" info comment on an owner's
 * doc). An open question the agent asked about that doc or its held write
 * goes, and so does one asked by another agent in the same project whose
 * question names that link: that agent is told. A temp store; invented
 * names.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import { NotificationStore } from "../../../src/shared/notifications";
import { Attention } from "../../../src/ui/server/attention";
import {
  approvalKeys,
  approvalNoticeText,
  isApproval,
  type Delivery,
} from "../../../src/shared/hub-delivery";

let dir = "";
const clock = Date.parse("2026-01-02T03:04:05.000Z");
const HELD = "0a1b2c3d-1111-4222-8333-944455556666";
const URL = "https://hub.example.test/a/pricing-page";

function mk() {
  const store = new NotificationStore(dir, () => new Date(clock));
  const a = new Attention({
    store,
    outputMark: async () => "m",
    nameOf: (x) => x,
    now: () => clock,
    hooked: () => true,
  });
  return { store, a };
}
const ask = (a: Attention, agent: string, ws: string, question: string) =>
  a.event(agent, ws, { event: "finished", question });

const dv = (o: Partial<Delivery> = {}): Delivery => ({
  id: "d1",
  kind: "approve",
  version: 3,
  agent: "ag-1",
  project: "web",
  thread: { kind: "decision", id: "th1", url: URL, artifact: "Pricing page" },
  author: {
    id: "u_me",
    login: "pat",
    name: "Pat Example",
    kind: "person",
    verified: "hub_session",
  },
  body: "",
  createdAt: "2026-01-02T03:00:00Z",
  ...o,
});
const OWNER = { ownerId: "u_me", company: "Acme" };

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-d2-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("P0-D2: which deliveries are approvals", () => {
  it("an owner's approve, held decision, or 'approved vN of' info comment", () => {
    expect(isApproval(dv(), OWNER)).toBe(true);
    expect(
      isApproval(dv({ kind: "held", body: `applied ${HELD}` }), OWNER),
    ).toBe(true);
    expect(
      isApproval(
        dv({
          kind: undefined,
          intent: "info",
          body: "@pat approved v3 of Pricing page",
        }),
        OWNER,
      ),
    ).toBe(true);
  });

  it("not an owner comment that only says it (no Hub info note), a deny, or another version's approval", () => {
    expect(
      isApproval(
        dv({ kind: undefined, body: "@pat approved v3 of Pricing page" }),
        OWNER,
      ),
    ).toBe(false);
    for (const body of [`denied ${HELD}`, `rejected ${HELD}`, "Declined."])
      expect([body, isApproval(dv({ kind: "held", body }), OWNER)]).toEqual([
        body,
        false,
      ]);
    expect(
      isApproval(
        dv({
          kind: undefined,
          intent: "info",
          version: 4,
          body: "@pat approved v3 of Pricing page",
        }),
        OWNER,
      ),
    ).toBe(false);
  });

  it("not a plain comment, a change request, or someone else's approval", () => {
    expect(isApproval(dv({ kind: undefined, body: "looks good" }), OWNER)).toBe(
      false,
    );
    expect(isApproval(dv({ kind: "request_changes" }), OWNER)).toBe(false);
    const other = dv();
    other.author = { ...other.author, id: "u_sam", login: "sam" };
    expect(isApproval(other, OWNER)).toBe(false);
  });

  it("its keys: the link, the thread and any held id in the body; never the doc's title", () => {
    const k = approvalKeys(dv({ kind: "held", body: `applied ${HELD}` }));
    expect(k).toEqual(expect.arrayContaining([URL, HELD]));
    expect(k).not.toContain("Pricing page");
  });
});

describe("P0-D2: an approval clears the questions that name it", () => {
  it("the agent's own question about that doc goes, and its row", async () => {
    const { store, a } = mk();
    await ask(a, "ag-1", "web", `1. Is ${URL} ready to approve?`);
    expect(a.approvedAbout("ag-1", "web", approvalKeys(dv()))).toEqual([
      { agent: "ag-1", key: URL },
    ]);
    expect(a.waitingNow().has("ag-1")).toBe(false);
    expect(
      store
        .list()
        .filter((n) => n.subject === "agent:ag-1" && n.kind === "waiting"),
    ).toHaveLength(0);
  });

  it("its question about something else stays, even one naming the doc's title", async () => {
    const { a } = mk();
    await ask(a, "ag-1", "web", "1. Shall I start the Pricing page's footer?");
    a.approvedAbout("ag-1", "web", approvalKeys(dv()));
    expect(a.waitingNow().get("ag-1")).toBe("asked");
  });

  it("another agent in the project whose question names the held link is cleared and returned; others aren't", async () => {
    const { a } = mk();
    const keys = approvalKeys(dv({ kind: "held", body: `applied ${HELD}` }));
    await ask(a, "ag-2", "web", `1. Do you allow the sign-off (held ${HELD})?`);
    await ask(
      a,
      "ag-3",
      "shop",
      `1. Do you allow the sign-off (held ${HELD})?`,
    );
    await ask(a, "ag-4", "web", "1. Shall I start the checkout page?");
    expect(a.approvedAbout("ag-1", "web", keys)).toEqual([
      { agent: "ag-2", key: HELD },
    ]);
    expect(a.waitingNow().has("ag-2")).toBe(false);
    expect(a.waitingNow().get("ag-3")).toBe("asked");
    expect(a.waitingNow().get("ag-4")).toBe("asked");
  });

  it("a held id only counts whole, never inside a longer one", async () => {
    const { a } = mk();
    await ask(a, "ag-2", "web", `1. Allow held ${HELD}7?`);
    expect(a.approvedAbout("ag-1", "web", [HELD])).toEqual([]);
    expect(a.waitingNow().get("ag-2")).toBe("asked");
  });

  it("a permission dialog stays", async () => {
    const { a } = mk();
    await a.event("ag-1", "web", {
      event: "waiting",
      why: "permission",
      what: `Pricing page ${URL}`,
      hooked: true,
    });
    a.approvedAbout("ag-1", "web", approvalKeys(dv()));
    expect(a.waitingNow().get("ag-1")).toBe("permission");
  });

  it("the notice another agent is told names the approver, the doc and the link", () => {
    const t = approvalNoticeText(dv(), OWNER);
    expect(t).toMatch(/^from: Den/);
    expect(t).toContain("Pat Example");
    expect(t).toContain('"Pricing page"');
    expect(t).toContain(URL);
  });
});
