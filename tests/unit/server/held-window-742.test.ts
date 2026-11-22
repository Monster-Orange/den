/**
 * Issue 742: the held-write Allow window is a setting (user.yml
 * held_writes.wait_minutes: 24 hours by default, 10 minutes to 7 days),
 * and what waits survives a restart.
 *
 *  - At the default window a request is still pending after 11 minutes,
 *    and Needs you still lists it.
 *  - It expires at the configured limit, read per ask.
 *  - Allow on an old request whose target changed returns the check's
 *    error and runs nothing.
 *  - The queue is written under the state dir: a rebuilt queue has the
 *    same pending request, same id and expiry, and Allow runs it.
 *  - A queue file that can't be read gives "lost", never an empty queue
 *    with no trace; so does a request whose action no longer exists, or
 *    one a restart cut off mid-run.
 *  - The MCP tool texts report the configured window, not "10 minutes".
 *
 * Temp dirs only; invented names only.
 */
import { describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  HELD_WAIT_MINUTES,
  heldWaitText,
  heldWriteWaitMinutes,
} from "../../../src/shared/den-config.js";
import { patchCliRows } from "../../../src/shared/settings-cli-rows.js";
import { ApprovalQueue } from "../../../src/ui/server/approvals.js";
import {
  approvalView,
  createApprovalQueue,
  type HeldActions,
} from "../../../src/ui/server/approval-routes.js";
import { heldWaiting } from "../../../src/ui/server/held-bell.js";
import { toolsFor } from "../../../src/ui/mcp/tools.js";

const MIN = 60_000;
const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));

const ask = {
  actor: "agent:north-planner",
  agent: "north-planner",
  action: "agent_create",
  args: { name: "helper" },
  summary: 'start the agent "helper"',
};

describe("issue 742: the window is a setting", () => {
  it("held_writes.wait_minutes: 24 hours by default, 10 minutes to 7 days", () => {
    expect(HELD_WAIT_MINUTES).toEqual({ default: 1440, min: 10, max: 10080 });
    expect(heldWriteWaitMinutes(() => ({}))).toBe(1440);
    expect(
      heldWriteWaitMinutes(() => ({ held_writes: { wait_minutes: 30 } })),
    ).toBe(30);
    // Out of range or not a number: the default, never a shorter wait.
    for (const bad of [5, 20000, "x", 0])
      expect(
        heldWriteWaitMinutes(() => ({ held_writes: { wait_minutes: bad } })),
      ).toBe(1440);
  });

  it("POST /api/settings' held_writes is checked against the range", () => {
    const user: Record<string, unknown> = {};
    expect(patchCliRows(user, { held_writes: { wait_minutes: 9 } })).toEqual({
      ok: false,
      error: "held_writes.wait_minutes is a whole number from 10 to 10080",
    });
    expect(patchCliRows(user, { held_writes: { wait_minutes: 60 } })).toEqual({
      ok: true,
    });
    expect(user).toEqual({ held_writes: { wait_minutes: 60 } });
    expect(patchCliRows(user, { held_writes: { wait_minutes: null } })).toEqual(
      { ok: true },
    );
    expect(user).toEqual({});
  });

  it("the window in words", () => {
    expect(heldWaitText(1440)).toBe("24 hours");
    expect(heldWaitText(10080)).toBe("7 days");
    expect(heldWaitText(60)).toBe("1 hour");
    expect(heldWaitText(10)).toBe("10 minutes");
    expect(heldWaitText(90)).toBe("90 minutes");
  });
});

describe("issue 742: a request waits for the whole window", () => {
  it("at the default window it is still pending after 11 minutes, and Needs you lists it", () => {
    let t = 1_000_000;
    const q = new ApprovalQueue({ now: () => t, run: async () => ({}) });
    const a = q.request(ask);
    t += 11 * MIN;
    expect(q.get(a.id)?.state).toBe("pending");
    expect(heldWaiting(q.pending()).map((w) => w.id)).toEqual([a.id]);
    expect(a.expiresAt - a.requestedAt).toBe(24 * 60 * MIN);
  });

  it("expires at the configured limit, read per ask", () => {
    let t = 1_000_000;
    let minutes = 30;
    const q = new ApprovalQueue({
      now: () => t,
      ttlMs: () => minutes * MIN,
      run: async () => ({}),
    });
    const a = q.request(ask);
    t += 30 * MIN - 1;
    expect(q.get(a.id)?.state).toBe("pending");
    t += 1;
    expect(q.get(a.id)?.state).toBe("expired");
    minutes = 60;
    const b = q.request(ask);
    expect(b.expiresAt - b.requestedAt).toBe(60 * MIN);
  });

  it("createApprovalQueue takes the window from the setting", () => {
    const q = createApprovalQueue({}, () => tmp("den-742-cq-"), {
      ttlMs: () => 45 * MIN,
    });
    const a = q.request(ask);
    expect(a.expiresAt - a.requestedAt).toBe(45 * MIN);
  });
});

describe("issue 742: Allow on an old request re-checks it", () => {
  it("a target that changed: the check's error, nothing runs", async () => {
    let ran = 0;
    let exists = false;
    const actions: HeldActions = {
      agent_create: {
        check: (args) =>
          exists
            ? { ok: false, error: 'An agent "helper" already exists.' }
            : {
                ok: true,
                args,
                summary: 'start the agent "helper"',
                params: {},
                details: [],
              },
        run: async () => {
          ran++;
          return { ok: true };
        },
      },
    };
    let t = 1_000_000;
    const q = createApprovalQueue(actions, () => tmp("den-742-stale-"), {
      now: () => t,
    });
    // The person's own MCP client asked (an agent's token would need to be live).
    const a = q.request({ ...ask, actor: "person:owner" });
    t += 20 * 60 * MIN;
    exists = true;
    const r = await q.decide(a.id, "allow", "sess");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.approval.result).toEqual({
      ok: false,
      error: 'An agent "helper" already exists.',
    });
    expect(ran).toBe(0);
  });
});

describe("issue 742: waiting requests survive a restart", () => {
  it("a rebuilt queue has the same pending request, same id and expiry; Allow runs it", async () => {
    const dir = tmp("den-742-persist-");
    const file = path.join(dir, "held-writes.json");
    let t = 1_000_000;
    const ran: unknown[] = [];
    const deps = {
      now: () => t,
      file,
      run: async (_a: string, args: Readonly<Record<string, unknown>>) => {
        ran.push(args);
        return { ok: true };
      },
    };
    const first = new ApprovalQueue(deps);
    const a = first.request(ask);
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.statSync(file).mode & 0o077).toBe(0);
    // No temp file left behind (written atomically: tmp + rename).
    expect(fs.readdirSync(dir)).toEqual(["held-writes.json"]);

    t += 60 * MIN;
    const again = new ApprovalQueue(deps);
    const b = again.get(a.id);
    expect(b).toMatchObject({
      id: a.id,
      state: "pending",
      expiresAt: a.expiresAt,
      requestedAt: a.requestedAt,
      action: "agent_create",
      summary: a.summary,
    });
    expect(again.pending().map((x) => x.id)).toEqual([a.id]);
    const r = await again.decide(a.id, "allow", "sess");
    expect(r.ok).toBe(true);
    expect(ran).toEqual([{ name: "helper" }]);
    // Settled: not written as waiting again.
    const third = new ApprovalQueue(deps);
    expect(third.pending()).toEqual([]);
  });

  it("one whose window ended while Den was down expires (and is told), not dropped", () => {
    const dir = tmp("den-742-lapsed-");
    const file = path.join(dir, "held-writes.json");
    let t = 1_000_000;
    const expired: string[] = [];
    const q1 = new ApprovalQueue({
      now: () => t,
      file,
      ttlMs: 30 * MIN,
      run: async () => ({}),
    });
    const a = q1.request(ask);
    t += 31 * MIN;
    const q2 = new ApprovalQueue({
      now: () => t,
      file,
      run: async () => ({}),
      onExpire: (x) => expired.push(x.id),
    });
    expect(q2.get(a.id)?.state).toBe("expired");
    expect(expired).toEqual([a.id]);
  });

  it("a corrupt queue file gives lost, not an empty queue", () => {
    const dir = tmp("den-742-corrupt-");
    const file = path.join(dir, "held-writes.json");
    fs.writeFileSync(file, "{ not json");
    const lost: string[] = [];
    const q = new ApprovalQueue({
      file,
      run: async () => ({}),
      onLost: (a, why) => lost.push(`${a?.id ?? "?"}: ${why}`),
    });
    const r = q.get("abcdefghijklmnop");
    expect(r?.state).toBe("lost");
    expect(approvalView(r!)).toMatchObject({
      id: "abcdefghijklmnop",
      state: "lost",
    });
    expect(String(approvalView(r!).reason)).toMatch(/lost/i);
    expect(lost).toHaveLength(1);
    // The broken file is kept aside for a look, never overwritten. Issue
    // 786: in <state>/backup, with its body.
    const kept = fs
      .readdirSync(path.join(dir, "backup"))
      .filter((f) => f.startsWith("held-writes.json.") && f.endsWith(".bad"));
    expect(kept).toHaveLength(1);
    expect(fs.readFileSync(path.join(dir, "backup", kept[0]), "utf8")).toBe(
      "{ not json",
    );
  });

  it("a request whose action no longer exists, or that a restart cut off mid-run, is lost", async () => {
    const dir = tmp("den-742-gone-");
    const file = path.join(dir, "held-writes.json");
    let release: () => void = () => {};
    const q1 = new ApprovalQueue({
      file,
      run: () => new Promise((r) => (release = () => r({ ok: true }))),
    });
    const old = q1.request({ ...ask, action: "old_tool" });
    const mid = q1.request(ask);
    const deciding = q1.decide(mid.id, "allow", "sess");
    await new Promise((r) => setImmediate(r));
    const lost: string[] = [];
    const q2 = new ApprovalQueue({
      file,
      knownAction: (n) => n !== "old_tool",
      run: async () => ({}),
      onLost: (a) => lost.push(a?.id ?? "?"),
    });
    expect(q2.get(old.id)?.state).toBe("lost");
    expect(q2.get(mid.id)?.state).toBe("lost");
    expect(q2.pending()).toEqual([]);
    expect(lost.sort()).toEqual([old.id, mid.id].sort());
    release();
    await deciding;
  });

  it("Den's own asks (actor den:…) are not written: the update check asks again", () => {
    const dir = tmp("den-742-den-");
    const file = path.join(dir, "held-writes.json");
    const q1 = new ApprovalQueue({ file, run: async () => ({}) });
    q1.request({ ...ask, actor: "den:update-check", action: "den_update" });
    const q2 = new ApprovalQueue({ file, run: async () => ({}) });
    expect(q2.pending()).toEqual([]);
  });
});

describe("issue 742: tool texts report the configured window", () => {
  const cfg = {
    actions: [],
    runTestsEnvs: [],
    logsRemote: false,
    approvals: true,
  } as unknown as Parameters<typeof toolsFor>[0];

  it("no tool says 10 minutes; the held writes and approval_check say the window", () => {
    const tools = toolsFor({ ...cfg, heldWaitMinutes: 2880 } as typeof cfg);
    for (const t of tools)
      expect(t.description).not.toMatch(/waits up to 10 minutes/);
    const create = tools.find((t) => t.name === "workspace_create")!;
    expect(create.description).toContain("A request waits up to 2 days");
    const check = tools.find((t) => t.name === "approval_check")!;
    expect(check.description).toContain("2 days");
    expect(check.description).toContain("lost");
  });
});
