/**
 * Issue 701: Hub delivered the reporter's comments, but Den held them with
 * no word to Hub, and the agent's own question kept them held forever.
 * - A held delivery is acked `queued` with a reason in plain words, once;
 *   again only when the reason changes (Hub shows it on the comment).
 * - The reason survives a restart: no second ack for the same reason.
 * - 404 on an ack: Hub has no such delivery; it leaves the queue.
 * - A comment from the agent's own person, once typed, answers its
 *   question (`answered`); someone else's comment doesn't.
 * Fake Hub, fake agents. Invented names only.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SeenDeliveries } from "../../../src/shared/hub/hub-delivery";
import {
  DeliveryLoop,
  type AgentState,
  type DeliveryHub,
} from "../../../src/shared/hub/hub-delivery-loop";

let dir = "";
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-dhack-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const dv = (id: string, author = "u_me") => ({
  id,
  agent: "ag-1",
  project: "web",
  thread: {
    kind: "comment",
    id: `th_${id}`,
    url: `https://hub.example.test/a/doc#th_${id}`,
    artifact: "Pricing page",
  },
  author: {
    id: author,
    login: author === "u_me" ? "pat" : "sam",
    name: author === "u_me" ? "Pat Example" : "Sam Example",
    kind: "person",
    verified: "hub_session",
  },
  body: `comment ${id}`,
  created_at: "2026-11-12T18:00:00Z",
});

function setup(
  o: {
    state?: AgentState;
    why?: string | null;
    owner?: boolean;
    ackFail?: (id: string) => unknown;
    seenFile?: string;
  } = {},
) {
  const acks: { id: string; state: string; reason?: unknown }[] = [];
  const typed: string[] = [];
  const answered: string[] = [];
  const logs: string[] = [];
  const st = { state: o.state ?? "busy", why: o.why ?? null } as {
    state: AgentState;
    why: string | null;
  };
  let owner = o.owner ?? true;
  const hub: DeliveryHub = {
    stream: () => {
      throw Object.assign(new Error("no stream"), { kind: "refused" });
    },
    list: async () => [],
    ack: async (id, body) => {
      const e = o.ackFail?.(id);
      if (e) throw e;
      acks.push({ id, state: String(body.state), reason: body.reason });
    },
  };
  const seenFile = o.seenFile ?? path.join(dir, "seen.json");
  const loop = new DeliveryLoop({
    hub,
    agents: {
      state: async () => st.state,
      why: async () => st.why,
      type: async (_a, text) => {
        typed.push(text);
        return true;
      },
    },
    owner: () => (owner ? { ownerId: "u_me", company: "Acme" } : null),
    seen: new SeenDeliveries(seenFile),
    answered: (a: string) => answered.push(a),
    log: (l) => logs.push(l),
  } as ConstructorParameters<typeof DeliveryLoop>[0]);
  return {
    loop,
    acks,
    typed,
    answered,
    logs,
    st,
    seenFile,
    setOwner: (v: boolean) => (owner = v),
    of: (id: string) => acks.filter((a) => a.id === id),
  };
}

describe("issue 701: a held delivery tells Hub why, once", () => {
  it("busy: acked queued with a plain reason, once across pumps", async () => {
    const s = setup();
    await s.loop.take(dv("d1"));
    await s.loop.pump();
    await s.loop.pump();
    expect(s.typed).toEqual([]);
    expect(s.of("d1")).toEqual([
      { id: "d1", state: "queued", reason: "the agent is busy with a turn" },
    ]);
  });

  it("the reason the install gives is used, and a new reason is acked again", async () => {
    const s = setup({ why: "permission" });
    await s.loop.take(dv("d1"));
    await s.loop.pump();
    s.st.why = null;
    await s.loop.pump();
    await s.loop.pump();
    expect(s.of("d1").map((a) => a.reason)).toEqual([
      "a permission question is on its screen",
      "the agent is busy with a turn",
    ]);
    s.st.state = "idle";
    await s.loop.pump();
    expect(s.typed).toHaveLength(1);
    expect(s.of("d1").map((a) => a.state)).toEqual([
      "queued",
      "queued",
      "delivered",
      "working",
    ]);
  });

  it("no owner known yet: queued with that reason", async () => {
    const s = setup({ state: "idle", owner: false });
    await s.loop.take(dv("d1"));
    expect(s.typed).toEqual([]);
    expect(s.of("d1")).toHaveLength(1);
    expect(s.of("d1")[0].state).toBe("queued");
    expect(String(s.of("d1")[0].reason)).toMatch(/who its person is/);
  });

  it("a restart between queued and typing: no second ack for the same reason, then typed", async () => {
    const s = setup();
    await s.loop.take(dv("d1"));
    expect(s.of("d1")).toHaveLength(1);
    const s2 = setup({ seenFile: s.seenFile });
    await s2.loop.pump();
    expect(s2.acks).toEqual([]);
    s2.st.state = "idle";
    await s2.loop.pump();
    expect(s2.typed).toHaveLength(1);
    expect(s2.of("d1").map((a) => a.state)).toEqual(["delivered", "working"]);
  });

  it("404 on the ack: Hub has no such delivery; dropped and logged, the rest go on", async () => {
    const s = setup({
      ackFail: (id) =>
        id === "d1" ? Object.assign(new Error("404"), { status: 404 }) : null,
    });
    await s.loop.take(dv("d1"));
    await s.loop.take(dv("d2"));
    expect(s.loop.work("ag-1")?.queued).toBe(1);
    expect(s.logs.some((l) => /d1.*not on Hub.*dropped/.test(l))).toBe(true);
    s.st.state = "idle";
    await s.loop.pump();
    expect(s.typed).toHaveLength(1);
    expect(s.typed[0]).not.toContain("comment d1");
    expect(s.typed[0]).toContain("comment d2");
  });

  it("another ack error never stalls the loop", async () => {
    const s = setup({
      ackFail: () => Object.assign(new Error("boom"), { status: 500 }),
    });
    await s.loop.take(dv("d1"));
    s.st.state = "idle";
    await s.loop.pump();
    expect(s.typed).toHaveLength(1);
  });
});

describe("issue 701: the person's comment answers the agent's question", () => {
  it("typed from its own person: answered", async () => {
    const s = setup({ state: "idle" });
    await s.loop.take(dv("d1"));
    expect(s.typed).toHaveLength(1);
    expect(s.answered).toEqual(["ag-1"]);
  });

  it("from someone else: not answered", async () => {
    const s = setup({ state: "idle" });
    await s.loop.take(dv("d1", "u_other"));
    expect(s.typed).toHaveLength(1);
    expect(s.answered).toEqual([]);
  });
});
