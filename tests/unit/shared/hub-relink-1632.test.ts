import { describe, expect, it } from "@jest/globals";
import {
  relinkMoved,
  type ArchivedLink,
  type HubProjectSeen,
} from "../../../src/shared/hub-moved.js";

const OLD = "https://old-hub.example.test";
const NEW = "https://new-hub.example.test";

const was = (ws: string, id: string): ArchivedLink => ({
  ws,
  id,
  slug: `${ws}-slug`,
  name: `${ws} name`,
  fromOrigin: OLD,
});
const seen = (id: string, from: string | null): HubProjectSeen => ({
  id,
  slug: `${id}-slug`,
  name: `${id} name`,
  movedFrom: from ? { hub: from } : null,
});

async function run(
  links: ArchivedLink[],
  onHub: Record<string, HubProjectSeen>,
  linkedNow: string[] = [],
) {
  const asked: string[] = [];
  const r = await relinkMoved(links, {
    lookup: async (id) => {
      asked.push(id);
      return onHub[id] ?? null;
    },
    linkedNow: (ws) => linkedNow.includes(ws),
  });
  return { ...r, asked };
}

describe("issue 1632 part 2: after a switch, moved projects re-link by identity", () => {
  it("re-links a project whose id the new Hub lists as moved from the old Hub", async () => {
    const r = await run([was("web", "p1")], { p1: seen("p1", OLD) });
    expect(r.relink).toEqual([
      { ws: "web", link: { id: "p1", slug: "p1-slug", name: "p1 name" } },
    ]);
    expect(r.ask).toEqual([]);
  });

  it("the same id with no move proof, or moved from another Hub: asks, never guesses", async () => {
    expect(
      (await run([was("web", "p1")], { p1: seen("p1", null) })).ask,
    ).toEqual(["web"]);
    expect(
      (
        await run([was("web", "p1")], {
          p1: seen("p1", "https://x.example.test"),
        })
      ).ask,
    ).toEqual(["web"]);
  });

  it("two projects that were linked to one Hub project: both asked, neither linked", async () => {
    const r = await run([was("web", "p1"), was("api", "p1")], {
      p1: seen("p1", OLD),
    });
    expect(r.relink).toEqual([]);
    expect(r.ask.sort()).toEqual(["api", "web"]);
  });

  it("not on the new Hub: left alone; already linked here: not looked up", async () => {
    const r = await run([was("web", "p1"), was("api", "p2")], {}, ["api"]);
    expect(r).toMatchObject({ relink: [], ask: [] });
    expect(r.asked).toEqual(["p1"]);
  });

  it("a lookup that fails leaves that project alone and goes on", async () => {
    const r = await relinkMoved([was("web", "p1"), was("api", "p2")], {
      lookup: async (id) => {
        if (id === "p1") throw new Error("down");
        return seen("p2", OLD);
      },
      linkedNow: () => false,
    });
    expect(r.relink.map((x) => x.ws)).toEqual(["api"]);
    expect(r.ask).toEqual([]);
  });

  it("the old Hub's origin is compared, not its path or case", async () => {
    const r = await run([was("web", "p1")], {
      p1: seen("p1", "https://OLD-hub.example.test/some/path"),
    });
    expect(r.relink.map((x) => x.ws)).toEqual(["web"]);
    void NEW;
  });
});
