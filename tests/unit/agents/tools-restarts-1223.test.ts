/**
 * Issue 1223: after Den updates, agents still on older tools are one bell
 * row, "N agents are on older tools", with one Restart N agents for the
 * person. It sends them through the restart queue (issue 1129: a batch at
 * a time, under the load ceiling), shows how far it got, and keeps an
 * agent that failed listed with its reason while the others finish.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { RestartQueue } from "../../../src/shared/agents/restart-queue.js";
import { ToolsRestarts } from "../../../src/shared/agents/tools-restarts.js";

const three = [
  { id: "ana", workspace: "north" },
  { id: "bo", workspace: "north" },
  { id: "cy", workspace: "south" },
];
const flush = () => new Promise<void>((r) => setImmediate(r));

/** A queue whose gap ends only when the test says. */
function gatedQueue(batch: number) {
  let open: (() => void) | null = null;
  const q = new RestartQueue({
    config: () => ({ batch, gapMs: 30_000, loadCeiling: 0 }),
    load: () => 0,
    sleep: () => new Promise<void>((r) => (open = r)),
  });
  return { q, gap: () => open?.() };
}

describe("issue 1223: one bell row for the agents on older tools", () => {
  it("three stale sessions: one row naming 3, with Restart 3", () => {
    const t = new ToolsRestarts({
      queue: { add: async () => undefined },
      restart: async () => undefined,
    });
    expect(t.row([])).toBeNull();
    expect(t.row(three)).toEqual({
      kind: "tools_old",
      id: "tools-old",
      n: 3,
      agents: [
        { agent: "ana", workspace: "north" },
        { agent: "bo", workspace: "north" },
        { agent: "cy", workspace: "south" },
      ],
    });
  });

  it("Restart sends all three through the queue, never more at once than its batch", async () => {
    const { q, gap } = gatedQueue(2);
    const started: string[] = [];
    const finish = new Map<string, () => void>();
    const t = new ToolsRestarts({
      queue: q,
      restart: (a) =>
        new Promise<void>((r) => {
          started.push(a.id);
          finish.set(a.id, r);
        }),
    });
    expect(t.start(three).map((a) => a.id)).toEqual(["ana", "bo", "cy"]);
    await flush();
    // The first batch only: two, then the gap.
    expect(started).toEqual(["ana", "bo"]);
    expect(t.row(three)?.restarting).toEqual({ done: 0, total: 3 });
    finish.get("ana")!();
    await flush();
    expect(t.row(three)?.restarting).toEqual({ done: 1, total: 3 });
    gap();
    await flush();
    expect(started).toEqual(["ana", "bo", "cy"]);
    finish.get("bo")!();
    finish.get("cy")!();
    await flush();
    // All back: the row clears, even before the stale list is asked again.
    expect(t.row(three)).toBeNull();
  });

  it("one that fails stays listed with its reason; the others finish", async () => {
    const t = new ToolsRestarts({
      queue: { add: (j) => j.run() },
      restart: async (a) => {
        if (a.id === "bo") throw new Error("bo exited at once");
      },
    });
    t.start(three);
    await flush();
    expect(t.row(three)).toEqual({
      kind: "tools_old",
      id: "tools-old",
      n: 1,
      agents: [
        { agent: "bo", workspace: "north", reason: "bo exited at once" },
      ],
    });
    // A new Restart tries it again.
    t.start([three[1]!]);
    await flush();
    expect(t.row([three[1]!])?.agents[0]?.reason).toBe("bo exited at once");
  });

  it("an agent already in a running batch isn't queued twice", async () => {
    const adds: string[] = [];
    const t = new ToolsRestarts({
      queue: {
        add: (j) => {
          adds.push(j.id);
          return new Promise(() => undefined);
        },
      },
      restart: async () => undefined,
    });
    t.start(three);
    expect(t.start(three)).toEqual([]);
    expect(adds).toEqual(["ana", "bo", "cy"]);
  });
});

describe("issue 1223: the bell draws it", () => {
  const g = globalThis as unknown as { window?: unknown };
  const had = g.window;
  beforeAll(() => {
    g.window = {
      denShell: {
        t: (k: string, v?: Record<string, unknown>) =>
          `[${k}${v ? `:${Object.values(v).join("|")}` : ""}]`,
      },
    };
  });
  afterAll(() => {
    g.window = had;
  });
  const needs = async (w: object) => {
    const { bellPanel } = await import("../../../src/ui/server/public/bell.js");
    const p = bellPanel({ groups: [], waiting: [w], unread: 0 });
    if (!("sections" in p)) throw new Error("the bell has no sections");
    return p.sections.needs as string;
  };

  it("one row naming 3, with Restart 3 agents", async () => {
    const html = await needs({
      kind: "tools_old",
      id: "tools-old",
      n: 3,
      agents: three.map((a) => ({ agent: a.id, workspace: a.workspace })),
    });
    expect(html.match(/data-kind="tools_old"/g)).toHaveLength(1);
    expect(html).toContain("[bell.to.row:3]");
    expect(html).toContain('data-bell="tools-restart" data-n="3"');
    expect(html).toContain("[bell.to.restart:3]");
  });

  it("while it runs, the button says how far it got; a failed one says why", async () => {
    const html = await needs({
      kind: "tools_old",
      id: "tools-old",
      n: 1,
      agents: [
        { agent: "bo", workspace: "north", reason: "bo exited at once" },
      ],
      restarting: { done: 1, total: 3 },
    });
    expect(html).toMatch(
      /data-bell="tools-restart" disabled aria-busy="true">\[bell\.to\.restarting:1\|3\]/,
    );
    expect(html).toContain("[bell.to.failed:bo|bo exited at once]");
  });

  it("issue 1407: one held back (a job) says why and has Restart now, not Restart N", async () => {
    const html = await needs({
      kind: "tools_old",
      id: "tools-old",
      n: 0,
      agents: [
        {
          agent: "bo",
          workspace: "north",
          waits: "job",
          job: { command: "npm run dev", minutes: 12 },
        },
      ],
    });
    expect(html).toContain("[bell.to.row1:1]");
    expect(html).toContain("[rs.job:bo|npm run dev|12]");
    expect(html).toContain(
      'data-bell="tools-now" data-rs-now="bo" data-rs-ws="north"',
    );
    expect(html).toContain("[rs.nowJob]");
    expect(html).not.toContain('data-bell="tools-restart"');
  });
});

describe("issue 1223: GET /api/notifications lists the row", () => {
  it("follows the gate rows; gone when there is none", async () => {
    const fs = await import("fs");
    const os = await import("os");
    const path = await import("path");
    const http = await import("http");
    const { NotificationStore } =
      await import("../../../src/shared/notifications.js");
    const { handleNotificationRoutes } =
      await import("../../../src/ui/server/notification-routes.js");
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "den-1223n-"));
    let row: object | null = {
      kind: "tools_old",
      id: "tools-old",
      n: 3,
      agents: [],
    };
    const attention = {
      waitingNow: () => new Map(),
      waitingDetail: () => null,
    } as unknown as Parameters<typeof handleNotificationRoutes>[3]["attention"];
    const server = http.createServer((req, res) => {
      void handleNotificationRoutes(req, res, "/api/notifications", {
        store: new NotificationStore(stateDir),
        attention,
        toolsOld: () => row as never,
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as { port: number };
    const get = async () =>
      (
        (await (
          await fetch(`http://127.0.0.1:${port}/api/notifications`)
        ).json()) as { waiting: { kind: string; n?: number }[] }
      ).waiting;
    try {
      expect(await get()).toEqual([row]);
      row = null;
      expect(await get()).toEqual([]);
    } finally {
      await new Promise((r) => server.close(r));
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });
});

describe("issue 1223: the server keeps the stale list for the bell", () => {
  it("asks in the background once it's old; the next read has it", async () => {
    const { toolsOldRow, resetToolsOld, STALE_TTL_MS } =
      await import("../../../src/ui/server/tools-old-service.js");
    resetToolsOld();
    const d = { stateDir: () => "/tmp/den-1223-svc" };
    let asks = 0;
    const ask = async () => (asks++, three);
    expect(toolsOldRow(d, ask, Date.now())).toBeNull();
    await flush();
    expect(toolsOldRow(d, ask, Date.now())?.n).toBe(3);
    // Within the TTL: not asked again.
    expect(asks).toBe(1);
    toolsOldRow(d, ask, Date.now() + STALE_TTL_MS);
    await flush();
    expect(asks).toBe(2);
    resetToolsOld();
  });
});
