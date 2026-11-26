import { describe, expect, it } from "@jest/globals";
import { readSyncReply } from "../../../src/shared/hub-project-sync.js";

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
