/**
 * Issue 271: Hub's push when an owner decides a change an agent asked for
 * (a new Hub project): top-level kind "held", thread.kind "held",
 * reply_with []. The agent gets its own words for it (not "something Den
 * doesn't know"), Hub's lines quoted ("New project <name>: <url>",
 * "slug: <slug>"), and Den reads every waiting create again at once, so a
 * project links on its own. Fake Hub, fake agents. Invented names only.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SeenDeliveries } from "../../../src/shared/hub/hub-delivery";
import {
  DeliveryLoop,
  type DeliveryHub,
} from "../../../src/shared/hub/hub-delivery-loop";

let dir = "";
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-dheld-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const held = (id: string, body: string, kind = "held") => ({
  id,
  agent: "ag-1",
  project: "den",
  kind,
  thread: { kind: "held", id: "held_1", url: "" },
  author: {
    id: "u_owner",
    login: "olive",
    name: "Olive Example",
    kind: "person",
    verified: "hub_session",
  },
  body,
  reply_with: [],
  created_at: "2026-11-17T18:00:00Z",
});

function setup() {
  const typed: string[] = [];
  const heard: string[] = [];
  const hub: DeliveryHub = {
    stream: () => {
      throw Object.assign(new Error("no stream"), { kind: "refused" });
    },
    list: async () => [],
    ack: async () => undefined,
  };
  const loop = new DeliveryLoop({
    hub,
    agents: {
      state: async () => "idle",
      type: async (_a, text) => {
        typed.push(text);
        return true;
      },
    },
    owner: () => ({ ownerId: "u_me", company: "Acme" }),
    seen: new SeenDeliveries(path.join(dir, "seen.json")),
    held: (d) => heard.push(d.id),
  });
  return { loop, typed, heard };
}

describe("issue 271: a held change decided in Hub", () => {
  it("the agent gets its own words, Hub's lines quoted; Den reads the asks again", async () => {
    const s = setup();
    await s.loop.take(
      held(
        "h1",
        "@olive allowed your project plan (1 project change): it is applied now.\n\nNew project North Star: http://127.0.0.1:9/acme?project=north-star\nslug: north-star",
      ),
    );
    expect(s.typed).toHaveLength(1);
    const t = s.typed[0];
    expect(t).not.toContain("doesn't know");
    expect(t.split("\n")[0]).toMatch(
      /^from: Olive Example \(someone else in Acme · verified by Hub session\) · via: Hub decision/,
    );
    expect(t).toContain("Olive Example decided a change you asked Hub for.");
    expect(t).toContain(
      "> New project North Star: http://127.0.0.1:9/acme?project=north-star",
    );
    expect(t).toContain("> slug: north-star");
    expect(t).toContain("Den links it to the project that asked by itself");
    expect(s.heard).toEqual(["h1"]);
  });

  it("a repeat isn't heard twice; other kinds aren't heard at all", async () => {
    const s = setup();
    await s.loop.take(held("h1", "declined"));
    await s.loop.take(held("h1", "declined"));
    await s.loop.take(held("c1", "a comment", "comment"));
    expect(s.heard).toEqual(["h1"]);
  });
});
