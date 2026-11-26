import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SeenDeliveries } from "../../../src/shared/hub-delivery";
import { DeliveryLoop } from "../../../src/shared/hub-delivery-loop";

let dir = "";
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-badheld-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const comment = (id: string) => ({
  id,
  agent: "ag-1",
  project: "web",
  thread: { kind: "comment", id: `th_${id}`, url: "", artifact: "Plan" },
  author: {
    id: "u_me",
    login: "pat",
    name: "Pat Example",
    kind: "person",
    verified: "hub_session",
  },
  body: `comment ${id}`,
  created_at: "2026-11-12T18:00:00Z",
});

function loopOn(seen: SeenDeliveries) {
  const typed: string[] = [];
  const loop = new DeliveryLoop({
    hub: {
      stream: () => {
        throw Object.assign(new Error("no stream"), { kind: "refused" });
      },
      list: async () => [],
      ack: async () => undefined,
    },
    agents: {
      state: async () => "idle",
      type: async (_a, text) => {
        typed.push(text);
        return true;
      },
    },
    owner: () => ({ ownerId: "u_me", company: "Acme" }),
    seen,
  });
  return { loop, typed };
}

const asides = () =>
  fs.readdirSync(dir).filter((f) => f.startsWith("seen.json.bad-"));

describe("a held file Den can't read never stops delivery", () => {
  for (const [what, text] of [
    ["truncated", '{"ids":["a","b"],"last":"b","held":{"queue":{"ag-1":[{"id'],
    ["garbled", "\u0000\u0000not json at all"],
    ["empty", ""],
  ] as const)
    it(`${what}: moved aside once, said once, and delivery goes on`, async () => {
      const file = path.join(dir, "seen.json");
      fs.writeFileSync(file, text);
      const bad: string[] = [];
      const counts: (number | null)[] = [];
      const seen = new SeenDeliveries(file, 5000, {
        onBad: (aside, n) => {
          bad.push(aside);
          counts.push(n);
        },
        now: () => 1_700_000_000_000,
      });
      expect(asides()).toHaveLength(1);
      expect(bad).toEqual([path.join(dir, asides()[0]!)]);
      expect(fs.readFileSync(bad[0]!, "utf-8")).toBe(text);
      expect(counts).toEqual([null]);
      const { loop, typed } = loopOn(seen);
      await loop.take(comment("c1"));
      expect(typed).toHaveLength(1);
      expect(JSON.parse(fs.readFileSync(file, "utf-8")).ids).toContain("c1");
      new SeenDeliveries(file, 5000, { onBad: (a) => bad.push(a) });
      expect(bad).toHaveLength(1);
    });

  it("no file yet: nothing moved aside, nothing said", () => {
    const bad: string[] = [];
    new SeenDeliveries(path.join(dir, "seen.json"), 5000, {
      onBad: (a) => bad.push(a),
    });
    expect(bad).toEqual([]);
    expect(asides()).toEqual([]);
  });

  it("a file that reads but holds odd shapes: the loop starts and delivers", async () => {
    const file = path.join(dir, "seen.json");
    fs.writeFileSync(
      file,
      JSON.stringify({
        ids: [1, null, "old"],
        last: 7,
        held: {
          queue: { "ag-1": [1, null, "x", { id: 5 }], other: "no" },
          active: { "ag-1": { ids: "x" }, b: null },
          gone: [null, 3, { id: "g" }],
        },
      }),
    );
    const { loop, typed } = loopOn(new SeenDeliveries(file));
    await loop.pump();
    await loop.take(comment("c2"));
    expect(typed).toHaveLength(1);
  });
});

describe("counting what a bad held file held", () => {
  it('each saved delivery after "held" counts once; a body\'s escaped key never does', async () => {
    const { heldCount } = await import("../../../src/shared/hub-delivery");
    const one = JSON.stringify({ ...comment("a"), body: '"created_at":"x"' });
    const two = JSON.stringify(comment("b"));
    const text = `{"ids":[],"held":{"queue":{"ag-1":[${one},${two}],"ag-2":[{"id":"c","crea`;
    expect(heldCount(text)).toBe(2);
    expect(heldCount('{"ids":["a"],"last":')).toBeNull();
    expect(heldCount('{"held":{"queue":{}}')).toBeNull();
  });
});

describe("the bell and log for a held file moved aside", () => {
  it("one bell item and one log line, naming the file and where it went", async () => {
    const { badDeliveryFile } =
      await import("../../../src/ui/server/hub-delivery-service.js");
    const added: { subject: string; text: string; msg?: unknown }[] = [];
    const logs: string[] = [];
    badDeliveryFile("/s/hub/deliveries-seen.json.bad-1700", {
      held: 3,
      store: {
        add: (n: (typeof added)[number]) => (added.push(n), null),
        withdraw: () => true,
      },
      log: (l) => logs.push(l),
    });
    expect(added).toHaveLength(1);
    expect(added[0]!.text).toBe(
      "Den couldn't read 3 held deliveries; kept the file as deliveries-seen.json.bad-1700.",
    );
    expect(added[0]!.msg).toEqual({
      key: "bell.m.deliveryFileBad",
      vars: {
        file: "deliveries-seen.json",
        moved: "deliveries-seen.json.bad-1700",
        n: 3,
      },
    });
    expect(logs).toEqual([`hub delivery: ${added[0]!.text}`]);
  });

  it("not countable: says the file couldn't be read, and keeps it", async () => {
    const { badDeliveryFile } =
      await import("../../../src/ui/server/hub-delivery-service.js");
    const added: { text: string; msg?: unknown }[] = [];
    badDeliveryFile("/s/hub/feed-pointers-seen.json.bad-1700", {
      held: null,
      store: {
        add: (n: (typeof added)[number]) => (added.push(n), null),
        withdraw: () => true,
      },
    });
    expect(added.map((a) => a.text)).toEqual([
      "Den couldn't read feed-pointers-seen.json or count its held deliveries; kept the file as feed-pointers-seen.json.bad-1700.",
    ]);
    expect((added[0]!.msg as { key: string }).key).toBe(
      "bell.m.deliveryFileBadUncounted",
    );
  });
});
