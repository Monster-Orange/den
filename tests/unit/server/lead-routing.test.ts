/**
 * Issue 101, lead routing: an agent's question goes to its project's lead
 * (a running agent whose persona's role is "lead" or "orchestrator"), not
 * to the person's Needs you; the lead sends the person only what needs
 * them. No lead, the lead asking, or a lead Den can't reach: Needs you,
 * as before. A temp store; fakes for the lead and the clock. Invented
 * names only.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import { bellView, NotificationStore } from "../../../src/shared/notifications";
import { Attention } from "../../../src/ui/server/attention";
import {
  LEAD_ROLES,
  leadAskText,
  pickLead,
  type LeadCandidate,
} from "../../../src/ui/server/lead-routing";

let dir = "";
const clock = 1_000_000;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-101-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const c = (id: string, o: Partial<LeadCandidate> = {}): LeadCandidate => ({
  id,
  workspace: "north",
  role: undefined,
  running: true,
  startedAt: "2026-11-17T10:00:00Z",
  ...o,
});

describe("issue 101: who is a project's lead", () => {
  it("the lead and orchestrator roles lead", () => {
    expect([...LEAD_ROLES]).toEqual(["lead", "orchestrator"]);
  });

  it("a running agent of a lead role in the asker's project", () => {
    const all = [
      c("dev"),
      c("boss", { role: "orchestrator" }),
      c("far", { role: "lead", workspace: "south" }),
    ];
    expect(pickLead(all, "north", "dev")).toBe("boss");
    expect(pickLead(all, "south", "x")).toBe("far");
  });

  it("the oldest when there are two; a stopped one doesn't lead", () => {
    const all = [
      c("b", { role: "lead", startedAt: "2026-11-17T11:00:00Z" }),
      c("a", {
        role: "lead",
        startedAt: "2026-11-17T09:00:00Z",
        running: false,
      }),
      c("z", { role: "orchestrator", startedAt: "2026-11-17T10:00:00Z" }),
    ];
    expect(pickLead(all, "north", "dev")).toBe("z");
  });

  it("no lead, or the asker is a lead: none (the person)", () => {
    expect(
      pickLead([c("dev"), c("rev", { role: "reviewer" })], "north", "dev"),
    ).toBe(null);
    expect(
      pickLead(
        [c("boss", { role: "lead" }), c("boss2", { role: "orchestrator" })],
        "north",
        "boss",
      ),
    ).toBe(null);
  });

  it("the lead's text says who asked, the question, and how to pass it on", () => {
    const t = leadAskText("Dev", "dev", "Ship it today?");
    expect(t).toContain("Dev");
    expect(t).toContain("Ship it today?");
    expect(t).toContain("ask_human");
    expect(t).not.toMatch(/\n/);
  });
});

function mk(o: {
  lead?: string | null;
  told?: boolean;
  tells?: { lead: string; text: string }[];
}) {
  const store = new NotificationStore(dir, () => new Date(clock));
  const a = new Attention({
    store,
    outputMark: async () => "m",
    nameOf: (id) => id.toUpperCase(),
    now: () => clock,
    hooked: () => true,
    leadOf: async () => o.lead ?? null,
    tellLead: async (lead, text) => {
      o.tells?.push({ lead, text });
      return o.told ?? true;
    },
  } as ConstructorParameters<typeof Attention>[0]);
  const view = () => bellView(store.list(), { off: [], foldDays: 3 }, clock);
  return { store, a, view };
}

describe("issue 101: an agent's question goes to its lead", () => {
  it("routed: the lead is told; nothing needs the person; an update says so", async () => {
    const tells: { lead: string; text: string }[] = [];
    const { a, view } = mk({ lead: "boss", tells });
    const r = await a.event("dev", "north", {
      event: "waiting",
      why: "asked",
      text: "Ship it today?",
      hooked: true,
    });
    expect(r).toEqual({ lead: "boss" });
    expect(tells).toEqual([
      { lead: "boss", text: leadAskText("DEV", "dev", "Ship it today?") },
    ]);
    // Still waiting (every list shows it), on its lead.
    expect(a.waitingNow().get("dev")).toBe("asked");
    const v = view();
    expect(v.unread).toBe(0);
    expect(v.recent).toHaveLength(0);
    expect(v.updates.map((n) => [n.kind, n.msg])).toEqual([
      [
        "finished",
        {
          key: "bell.m.toLead",
          vars: { name: "DEV", lead: "BOSS", text: "Ship it today?" },
        },
      ],
    ]);
  });

  it("the same question again isn't told twice", async () => {
    const tells: { lead: string; text: string }[] = [];
    const { a } = mk({ lead: "boss", tells });
    for (let i = 0; i < 2; i++)
      await a.event("dev", "north", {
        event: "waiting",
        why: "asked",
        text: "Ship it today?",
        hooked: true,
      });
    expect(tells).toHaveLength(1);
  });

  it("no lead: Needs you, as before", async () => {
    const { a, view } = mk({ lead: null });
    const r = await a.event("dev", "north", {
      event: "waiting",
      why: "asked",
      text: "Ship it today?",
      hooked: true,
    });
    expect(r).toBeUndefined();
    expect(view().unread).toBe(1);
  });

  it("a lead Den can't reach: Needs you", async () => {
    const { a, view } = mk({ lead: "boss", told: false });
    const r = await a.event("dev", "north", {
      event: "waiting",
      why: "asked",
      text: "Ship it today?",
      hooked: true,
    });
    expect(r).toBeUndefined();
    expect(view().unread).toBe(1);
    expect(view().recent[0]!.msg?.key).toBe("bell.m.asked");
  });

  it("a permission prompt still goes to the person (only they can allow it)", async () => {
    const tells: { lead: string; text: string }[] = [];
    const { a, view } = mk({ lead: "boss", tells });
    await a.event("dev", "north", {
      event: "waiting",
      why: "permission",
      what: "Bash",
      hooked: true,
    });
    expect(tells).toHaveLength(0);
    expect(view().unread).toBe(1);
  });
});

describe("issue 101: the words", () => {
  it("bell.m.toLead is in en, es and ja", () => {
    const root = path.join(__dirname, "../../../src/ui/server/public");
    for (const f of ["shell.js", "i18n/es.js", "i18n/ja.js"])
      expect([f, fs.readFileSync(path.join(root, f), "utf8")]).toEqual([
        f,
        expect.stringMatching(
          /"bell\.m\.toLead": "[^"]*\{name\}[^"]*\{lead\}[^"]*\{text\}/,
        ),
      ]);
  });

  it("ask_human says the question went to the lead, when it did", async () => {
    const { callTool } = await import("../../../src/ui/mcp/tools.js");
    const api = {
      baseUrl: "http://localhost:47003",
      async get(p: string) {
        if (p === "/api/workspaces")
          return { active: ["north"], workspaces: { north: {} } };
        return { ok: true, lead: "Boss" };
      },
      async stream() {
        throw new Error("no streams here");
      },
    };
    const r = await callTool("ask_human", { question: "Ship it today?" }, {
      api,
      cfg: {
        actions: [],
        runTestsEnvs: ["local"],
        logsRemote: false,
        approvals: true,
      },
      cli: "acme",
      scope: { workspace: "north", actor: "agent:dev" },
    } as unknown as Parameters<typeof callTool>[2]);
    expect(r.isError).toBeFalsy();
    expect(r.text).toMatch(/lead, Boss/);
    expect(r.text).not.toMatch(/in their bell/);
  });
});
