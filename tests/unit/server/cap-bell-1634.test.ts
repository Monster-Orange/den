import { describe, expect, it } from "@jest/globals";
import { capHeldOf, noteCapHeld } from "../../../src/ui/server/cap-bell.js";
import { enCatalog, langCatalog } from "./helpers/en-catalog.js";

type Added = Parameters<Parameters<typeof noteCapHeld>[0]["add"]>[0];

function store() {
  const items: Added[] = [];
  return {
    items,
    add: (n: Added) => {
      items.push(n);
      return null;
    },
  };
}

describe("issue 1634: the bell names the cap that held a start", () => {
  it("reads both caps' refusals", () => {
    expect(
      capHeldOf(
        "2 agents are running in project north and its cap is 2 (agents.max_per_project)",
      ),
    ).toEqual({
      n: 2,
      limit: 2,
      key: "agents.max_per_project",
      project: "north",
    });
    expect(
      capHeldOf(
        "1 agent is running in project north and its cap is 1 (workspaces.north.agents.max_per_project)",
      ),
    ).toMatchObject({ key: "workspaces.north.agents.max_per_project" });
    expect(
      capHeldOf("4 agents are running and agents.max_concurrent is 4"),
    ).toEqual({
      n: 4,
      limit: 4,
      key: "agents.max_concurrent",
    });
    expect(capHeldOf("could not open a PTY for claude: gone")).toBeNull();
  });

  it("one bell item per agent, naming the cap and linking the agent", () => {
    const s = store();
    expect(
      noteCapHeld(s, {
        agent: "planner",
        name: "Planner",
        project: "north",
        why: "2 agents are running in project north and its cap is 2 (agents.max_per_project)",
      }),
    ).toBe(true);
    expect(s.items).toEqual([
      expect.objectContaining({
        kind: "service",
        subject: "record:cap-held:planner",
        scope: "workspace/north",
        text: "Planner didn't start: 2 agents are running in project north and its cap is 2 (agents.max_per_project)",
        msg: {
          key: "bell.m.capHeld",
          vars: {
            name: "Planner",
            n: 2,
            limit: 2,
            key: "agents.max_per_project",
          },
        },
        link: "/agents?project=north&agent=planner",
      }),
    ]);
    expect(
      noteCapHeld(s, {
        agent: "x",
        name: "x",
        project: "north",
        why: "no such folder",
      }),
    ).toBe(false);
    expect(s.items).toHaveLength(1);
  });

  it("its words are in en, es and ja", async () => {
    for (const cat of [
      await enCatalog(),
      await langCatalog("es"),
      await langCatalog("ja"),
    ]) {
      expect(cat["bell.m.capHeld"]).toMatch(/\{name\}/);
      expect(cat["bell.m.capHeld"]).toMatch(/\{key\}/);
    }
  });
});

describe("issue 1634: a resume a cap refused, after a restart", () => {
  it("rings once per agent the cap held, and not for other failures", async () => {
    const fs = await import("fs");
    const os = await import("os");
    const path = await import("path");
    const { noteCapsHeld } = await import("../../../src/ui/server/cap-bell.js");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-cap-bell-"));
    fs.mkdirSync(path.join(dir, "agents"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "agents", "planner.json"),
      JSON.stringify({
        id: "planner",
        workspace: "north",
        displayName: "Planner",
      }),
    );
    const s = store();
    const n = await noteCapsHeld(
      dir,
      [
        {
          agent: "planner",
          why: "4 agents are running and agents.max_concurrent is 4",
        },
        { agent: "planner", why: "exited at once" },
        {
          agent: "gone",
          why: "4 agents are running and agents.max_concurrent is 4",
        },
      ],
      s,
    );
    expect(n).toBe(1);
    expect(s.items[0]).toMatchObject({
      subject: "record:cap-held:planner",
      msg: { vars: { key: "agents.max_concurrent", limit: 4 } },
    });
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
