import { describe, expect, it } from "@jest/globals";
import {
  ProjectSync,
  readSyncReply,
} from "../../../src/shared/hub/hub-project-sync.js";
import { hubGetProject } from "../../../src/shared/hub.js";

const MOVED_TO = {
  hub: "https://new-hub.example.test",
  hubName: "New Hub",
  company: "north",
  project: "p_123",
  at: "2026-11-30T17:00:00.000Z",
};

describe("issue 1632 part 2: the sync reply's moved projects", () => {
  it("a reply with no moved key has none", () => {
    expect(readSyncReply({ setups: 1 }).moved).toEqual([]);
  });

  it("reads each moved project, with where it went", () => {
    const r = readSyncReply({
      setups: 1,
      moved: [{ workspace: "web", hub_project: "p_123", movedTo: MOVED_TO }],
    });
    expect(r.moved).toEqual([
      { workspace: "web", hubProject: "p_123", movedTo: MOVED_TO },
    ]);
  });

  it("drops an entry with no workspace, no project, or a Hub address Den wouldn't connect to", () => {
    const bad = (o: Record<string, unknown>) =>
      readSyncReply({ moved: [o] }).moved;
    expect(bad({ hub_project: "p_1", movedTo: MOVED_TO })).toEqual([]);
    expect(bad({ workspace: "web", movedTo: MOVED_TO })).toEqual([]);
    expect(
      bad({
        workspace: "web",
        hub_project: "p_1",
        movedTo: { ...MOVED_TO, hub: "javascript:alert(1)" },
      }),
    ).toEqual([]);
    expect(readSyncReply({ moved: "yes" }).moved).toEqual([]);
  });

  it("drops a project name that isn't a project name here", () => {
    for (const workspace of ["../web", "web name", "-web", "x".repeat(65)])
      expect(
        readSyncReply({
          moved: [{ workspace, hub_project: "p_1", movedTo: MOVED_TO }],
        }).moved,
      ).toEqual([]);
  });

  it("keeps Hub's words to printable characters, at most 200", () => {
    const r = readSyncReply({
      moved: [
        {
          workspace: "web",
          hub_project: "p_1",
          movedTo: { ...MOVED_TO, hubName: `New\u0007 ${"x".repeat(300)}` },
        },
      ],
    });
    expect(r.moved[0].movedTo.hubName).toMatch(/^New x+$/);
    expect(r.moved[0].movedTo.hubName.length).toBeLessThanOrEqual(200);
  });
});

describe("issue 1632 part 2: one Hub project by id, with its move", () => {
  const ID = "0b6c1d2e-3f40-4a5b-8c6d-7e8f90a1b2c3";
  const answer = (status: number, body: unknown) =>
    (async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof fetch;

  it("reads the project and where it came from", async () => {
    const seen: string[] = [];
    const f = (async (u: string) => {
      seen.push(u);
      return answer(200, {
        project: { id: ID, slug: "web", name: "Web" },
        movedTo: null,
        movedFrom: { ...MOVED_TO, hub: "https://old-hub.example.test" },
      })(u);
    }) as unknown as typeof fetch;
    const p = await hubGetProject("https://new-hub.example.test", "t", ID, {
      fetch: f,
    });
    expect(seen).toEqual([`https://new-hub.example.test/api/projects/${ID}`]);
    expect(p).toEqual({
      id: ID,
      slug: "web",
      name: "Web",
      movedFrom: { hub: "https://old-hub.example.test" },
      movedTo: null,
    });
  });

  it("a 404 is no such project here: null", async () => {
    expect(
      await hubGetProject("https://h.example.test", "t", ID, {
        fetch: answer(404, { error: "no such project" }),
      }),
    ).toBeNull();
  });

  it("an answer with no project, or an id that isn't Den's to ask for, is null", async () => {
    expect(
      await hubGetProject("https://h.example.test", "t", ID, {
        fetch: answer(200, { movedTo: null }),
      }),
    ).toBeNull();
    expect(
      await hubGetProject("https://h.example.test", "t", "../installs", {
        fetch: answer(200, {}),
      }),
    ).toBeNull();
  });
});

describe("issue 1632 part 2: the sync says which projects moved", () => {
  const sync = (reply: Record<string, unknown>) => {
    const told: unknown[] = [];
    const s = new ProjectSync({
      list: () => [
        {
          workspace: "web",
          name: "web",
          repos: [],
          hub_project: "p_1",
          agents: [],
        },
      ],
      send: async () => reply,
      moved: (m) => void told.push(m),
      setTimer: () => 0,
      clearTimer: () => undefined,
    });
    return { s, told };
  };

  it("tells the moved projects once a reply names them", async () => {
    const r = sync({
      moved: [{ workspace: "web", hub_project: "p_1", movedTo: MOVED_TO }],
    });
    await r.s.run();
    expect(r.told).toEqual([
      [{ workspace: "web", hubProject: "p_1", movedTo: MOVED_TO }],
    ]);
    expect(r.s.last()?.moved).toHaveLength(1);
  });

  it("a project this Den didn't send is never told: Hub can't add a bell row for any name", async () => {
    const r = sync({
      moved: [
        { workspace: "web", hub_project: "p_1", movedTo: MOVED_TO },
        { workspace: "elsewhere", hub_project: "p_2", movedTo: MOVED_TO },
      ],
    });
    await r.s.run();
    expect(r.told).toEqual([
      [{ workspace: "web", hubProject: "p_1", movedTo: MOVED_TO }],
    ]);
  });

  it("a reply with none tells nothing", async () => {
    const r = sync({ setups: 0 });
    await r.s.run();
    expect(r.told).toEqual([]);
  });
});
