import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { bindHub, HUB_STATE_FILES } from "../../../src/shared/hub-binding.js";
import { NotificationStore } from "../../../src/shared/notifications.js";
import { ApprovalQueue } from "../../../src/ui/server/approvals.js";
import {
  noteHub,
  type HubChangeDeps,
} from "../../../src/ui/server/hub-change.js";
import {
  closeHubHeld,
  HUB_HELD_ACTIONS,
} from "../../../src/ui/server/hub-held-close.js";
import { hubProjectLines } from "../../../src/ui/cli/doctor-command.js";
import type { WorkspacesFile } from "../../../src/shared/types/index.js";

const OLD = "https://hub-one.example.test";
const NEW = "https://hub-two.example.test";

let dir: string;
let ws: WorkspacesFile;
let store: NotificationStore;
const log: string[] = [];

function deps(over: Partial<HubChangeDeps> = {}): HubChangeDeps {
  return {
    stateDir: () => dir,
    now: () => new Date("2026-11-26T10:00:00.000Z"),
    readWorkspaces: () => structuredClone(ws),
    writeWorkspaces: (f) => void (ws = structuredClone(f)),
    bell: () => store,
    stopLoops: async () => void log.push("stop loops"),
    audit: (d) => void log.push(`audit ${d}`),
    readToken: async () => null,
    revoke: async () => true,
    forget: async () => undefined,
    owns: () => true,
    config: () => null,
    readUser: () => ({}),
    writeUser: () => undefined,
    ...over,
  };
}

const put = (rel: string, body = "{}") => {
  const f = path.join(dir, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, body);
  return f;
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "hub-leftovers-"));
  log.length = 0;
  store = new NotificationStore(dir);
  ws = {
    workspaces: {
      web: { name: "web", hub_project: { id: "proj_old1", slug: "w" } },
    },
  } as unknown as WorkspacesFile;
  bindHub({ ...deps(), stateDir: dir } as never, { url: OLD, company: "one" });
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function queue() {
  const T0 = Date.parse("2026-11-26T09:00:00Z");
  return new ApprovalQueue({
    now: () => T0,
    ttlMs: 60 * 60_000,
    run: async () => ({ ok: true }),
  });
}

describe("issue 1632 part 3: a Hub change leaves nothing of the old Hub", () => {
  it("the delivery log is the old Hub's, so it is archived with the rest", () => {
    expect(HUB_STATE_FILES).toContain("deliveries.jsonl");
  });

  it("files naming the old Hub's answers go: Den's address tell, the names check, each agent's Hub notes", async () => {
    const gone = [
      put("hub-den-url.json", '{"outcome":"refused"}'),
      put("hub-names-check.json", '{"failAt":"2026-11-25T00:00:00Z"}'),
      put(path.join("agent-files", "a1", "hub-mcp.json")),
      put(path.join("agent-files", "a1", "hub-inbox.json"), '{"yours":3}'),
      put(path.join("agent-files", "a2", "hub-inbox.json"), '{"yours":1}'),
    ];
    const kept = put(path.join("agent-files", "a1", "mcp.json"));
    const r = await noteHub(deps(), { url: NEW });
    expect(r.kind).toBe("change");
    for (const f of gone) expect(fs.existsSync(f)).toBe(false);
    expect(fs.existsSync(kept)).toBe(true);
  });

  it("an agent-files entry that links elsewhere is left alone", async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "hub-outside-"));
    try {
      const f = path.join(outside, "hub-inbox.json");
      fs.writeFileSync(f, "{}");
      fs.mkdirSync(path.join(dir, "agent-files"), { recursive: true });
      fs.symlinkSync(outside, path.join(dir, "agent-files", "a9"));
      await noteHub(deps(), { url: NEW });
      expect(fs.existsSync(f)).toBe(true);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("the bell's 'agents without Hub' row goes: it counted against the old Hub", async () => {
    store.add({
      kind: "service",
      subject: "record:agents-without-hub",
      scope: "workspace/den-server",
      text: "2 agents have no Hub tools",
      msg: { key: "bell.m.noHub", vars: { n: 2 } },
    });
    await noteHub(deps(), { url: NEW });
    expect(
      store.list().filter((n) => n.subject === "record:agents-without-hub"),
    ).toEqual([]);
  });

  it("a change asks to close held writes that name the old Hub, saying from and to", async () => {
    const calls: string[] = [];
    await noteHub(
      deps({
        closeHeld: async (from, to) => {
          calls.push(`${from} -> ${to}`);
          return 1;
        },
      }),
      { url: NEW },
    );
    expect(calls).toEqual([`${OLD} -> ${NEW}`]);
    expect(log.some((l) => /1 held write/.test(l))).toBe(true);
  });

  it("the same Hub closes nothing", async () => {
    const calls: string[] = [];
    await noteHub(
      deps({
        closeHeld: async (from, to) => {
          calls.push(`${from} -> ${to}`);
          return 0;
        },
      }),
      { url: OLD },
    );
    expect(calls).toEqual([]);
  });
});

describe("issue 1632 part 3: held writes for the old Hub are closed with a note", () => {
  it("the actions that name a Hub project", () => {
    expect([...HUB_HELD_ACTIONS].sort()).toEqual([
      "hub_link",
      "hub_project_create",
    ]);
  });

  it("closes each pending Hub write, keeps the rest, rings the bell and tells the agent", async () => {
    const q = queue();
    const link = q.request({
      actor: "agent:a1",
      agent: "a1",
      action: "hub_link",
      args: { project: "web", hub: "proj_old1", slug: "w", name: "Web" },
      summary: "Link web to Hub project Web",
    });
    const create = q.request({
      actor: "agent:a2",
      agent: "a2",
      action: "hub_project_create",
      args: { project: "api", name: "API" },
      summary: "Create Hub project API",
    });
    const other = q.request({
      actor: "agent:a1",
      agent: "a1",
      action: "workspace_create",
      args: { name: "docs" },
      summary: "Create workspace docs",
    });
    const told: string[] = [];
    let synced = 0;
    const ids = await closeHubHeld(
      {
        pending: () => q.pending(),
        end: (id, why) => q.endBecause(id, why),
        store,
        tell: async (agent, text) => {
          told.push(`${agent}: ${text}`);
          return "told";
        },
        synced: () => void synced++,
      },
      OLD,
      NEW,
    );
    expect(ids.sort()).toEqual([link.id, create.id].sort());
    expect(q.get(link.id)).toMatchObject({ state: "lost" });
    expect(q.get(link.id)?.lostBecause).toContain(NEW);
    expect(q.get(create.id)).toMatchObject({ state: "lost" });
    expect(q.get(other.id)).toMatchObject({ state: "pending" });
    expect(await q.decide(link.id, "allow", "k")).toMatchObject({
      ok: false,
    });
    const rows = store
      .list()
      .filter((n) => n.subject.startsWith("record:held-lost-"));
    expect(rows.map((n) => n.msg?.key).sort()).toEqual([
      "bell.m.heldClosedHub",
      "bell.m.heldClosedHub",
    ]);
    for (const n of rows) {
      expect(n.msg?.vars).toMatchObject({ from: OLD, to: NEW });
      expect(n.text).toContain("Nothing ran");
    }
    expect(told).toHaveLength(2);
    for (const t of told) {
      expect(t).toContain(OLD);
      expect(t).toContain(NEW);
      expect(t).toMatch(/Nothing ran/);
    }
    expect(synced).toBe(1);
  });

  it("a request already being decided is left alone", async () => {
    const q = queue();
    const a = q.request({
      actor: "agent:a1",
      agent: "a1",
      action: "hub_link",
      args: { project: "web", hub: "proj_old1", slug: "w", name: "Web" },
      summary: "Link web",
    });
    await q.decide(a.id, "deny", "k");
    expect(q.endBecause(a.id, "moved")).toBeNull();
  });
});

describe("issue 1632 part 3: Doctor names the Hub each project's link is on", () => {
  it("a linked project says which Hub", () => {
    const { lines, checks } = hubProjectLines(
      true,
      [{ ws: "web", link: { slug: "w", name: "Web" } }],
      "den",
      NEW,
    );
    expect(lines.join("\n")).toContain("hub-two.example.test");
    expect(checks[0]?.detail).toContain("on hub-two.example.test");
  });

  it("without the address, the line is as before", () => {
    const { checks } = hubProjectLines(
      true,
      [{ ws: "web", link: { slug: "w", name: "Web" } }],
      "den",
    );
    expect(checks[0]?.detail).toBe("web: linked to Hub project Web (w)");
  });
});
