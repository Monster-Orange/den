/**
 * AG-6a for ON-3's held writes: an agent with a request waiting for the
 * person is "waiting" in the Agents list (the shell's chip, its rail row),
 * and stops being so once the person answers.
 */
import { afterAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { writeRecord } from "../../../src/shared/agents/records.js";
import { listedSessions } from "../../../src/ui/server/session-routes.js";
import { ApprovalQueue } from "../../../src/ui/server/approvals.js";

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "den-wait-"));
afterAll(() => fs.rmSync(stateDir, { recursive: true, force: true }));

const agent = (id: string) => {
  writeRecord(stateDir, {
    id,
    persona: "sde",
    runtime: "den-claude",
    workspace: "north",
    cwd: "/w/north",
    session: { backend: "den-pty", id: `s-${id}` },
    sessionName: `acme-north:${id}`,
    startedAt: "2026-11-07T10:00:00.000Z",
  });
  return {
    ref: { backend: "den-pty", id: `s-${id}` },
    name: `acme-north:${id}`,
    pid: 1,
    startedAt: "2026-11-07T10:00:00.000Z",
  };
};

const rows = (waiting: Set<string>) =>
  listedSessions([agent("server"), agent("scout")], {
    stateDir: () => stateDir,
    dist: () => "acme",
    activeWorkspaces: () => ["north"],
    waitingAgents: () => waiting,
  });

describe("an agent waiting for the person", () => {
  it("its row says waiting; others don't", () => {
    const by = (id: string, r: ReturnType<typeof rows>) =>
      r.find((x) => x.agent === id);
    const r = rows(new Set(["server"]));
    expect(by("server", r)?.waiting).toBe(true);
    expect(by("scout", r)).not.toHaveProperty("waiting");
  });

  it("the queue names who waits, until the person answers", async () => {
    const q = new ApprovalQueue({ run: async () => ({ ok: true }) });
    const a = q.request({
      actor: "agent:server",
      action: "workspace_create",
      args: { name: "web" },
      summary: 'create the workspace "web"',
    });
    q.request({
      actor: "loopback",
      action: "workspace_create",
      args: { name: "x" },
      summary: 'create the workspace "x"',
    });
    expect([...q.waitingActors()].sort()).toEqual(["agent:server", "loopback"]);
    await q.decide(a.id, "deny", "s1");
    expect([...q.waitingActors()]).toEqual(["loopback"]);
  });
});
