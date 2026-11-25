import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { RestartQueue } from "../../../src/shared/agents/restart-queue.js";
import { ToolsRestarts } from "../../../src/shared/agents/tools-restarts.js";
import type { RestartJob } from "../../../src/shared/agents/restart-queue.js";
import {
  resetToolsOld,
  restartToolsOld,
} from "../../../src/ui/server/tools-old-service.js";

const three = [
  { id: "ana", workspace: "north" },
  { id: "bo", workspace: "north" },
  { id: "cy", workspace: "south" },
];
const flush = () => new Promise<void>((r) => setImmediate(r));

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
    t.start([three[1]!]);
    await flush();
    expect(t.row([three[1]!])?.agents[0]?.reason).toBe("bo exited at once");
  });

  it("a failure's reason reaches the row redacted, one line, short", async () => {
    const SECRET = "den_pt_" + "Q".repeat(40);
    const t = new ToolsRestarts({
      queue: { add: (j) => j.run() },
      restart: async () => {
        throw new Error(
          `spawn failed: DEN_TOKEN=${SECRET} ${"x".repeat(400)}\nstderr: ${SECRET}`,
        );
      },
    });
    t.start([three[0]!]);
    await flush();
    const reason = t.row([three[0]!])!.agents[0]!.reason!;
    expect(reason).not.toContain(SECRET);
    expect(reason).not.toContain("\n");
    expect(reason.length).toBeLessThanOrEqual(200);
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

  it("one id in two projects is two agents: both queued, both listed, one's finish leaves the other", async () => {
    const two = [
      { id: "builder", workspace: "north" },
      { id: "builder", workspace: "south" },
    ];
    const finish = new Map<string, () => void>();
    const t = new ToolsRestarts({
      queue: { add: (j) => j.run() },
      restart: (a) => new Promise<void>((r) => finish.set(a.workspace, r)),
    });
    expect(t.start(two).map((a) => a.workspace)).toEqual(["north", "south"]);
    finish.get("north")!();
    await flush();
    expect(t.row(two)).toMatchObject({
      n: 1,
      agents: [{ agent: "builder", workspace: "south" }],
      restarting: { done: 1, total: 2 },
    });
  });

  it("one id in two projects through a real restart queue: each runs its own restart", async () => {
    const q = new RestartQueue({
      config: () => ({ batch: 4, gapMs: 0, loadCeiling: 0 }),
      load: () => 0,
      sleep: async () => undefined,
    });
    const ran: string[] = [];
    const t = new ToolsRestarts({
      queue: q,
      restart: async (a) => {
        ran.push(a.workspace);
      },
    });
    const two = [
      { id: "builder", workspace: "north" },
      { id: "builder", workspace: "south" },
    ];
    t.start(two);
    await q.idle();
    await flush();
    expect(ran.sort()).toEqual(["north", "south"]);
    expect(t.row(two)).toBeNull();
  });

  it("a queued agent restarts through its own caller's restart, not a later caller's", async () => {
    resetToolsOld();
    const held: RestartJob[] = [];
    const ran: string[] = [];
    const dir = "/state/t1223-own-restart";
    restartToolsOld(dir, [{ id: "ana", workspace: "north" }], {
      queue: {
        add: (j) => {
          held.push(j);
          return new Promise(() => undefined);
        },
      },
      restart: async (a) => {
        ran.push(`first:${a.id}`);
      },
    });
    restartToolsOld(dir, [{ id: "bo", workspace: "north" }], {
      queue: { add: (j) => j.run() },
      restart: async (a) => {
        if (a.id !== "bo") throw new Error("not mine");
        ran.push(`second:${a.id}`);
      },
    });
    await held[0]!.run();
    expect(ran.sort()).toEqual(["first:ana", "second:bo"]);
    resetToolsOld();
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
    expect(asks).toBe(1);
    toolsOldRow(d, ask, Date.now() + STALE_TTL_MS);
    await flush();
    expect(asks).toBe(2);
    resetToolsOld();
  });
});
