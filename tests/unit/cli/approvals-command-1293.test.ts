/**
 * Issue 1293: `<cli> approvals withdraw <id>` and `<cli> approvals list
 * --mine`, as whoever runs them (the route decides: only the asker may
 * withdraw). Scriptable: withdraw exits 0 when the request is withdrawn or
 * had already ended, 1 with the reason when it isn't the caller's, isn't
 * known, or Den didn't answer, and 2 on a usage error. The server's answers
 * are stand-ins. Invented names only.
 */
import { describe, expect, it } from "@jest/globals";
import {
  cmdApprovals,
  type ApprovalsIo,
} from "../../../src/ui/cli/approvals-command.js";

type Answer = { status: number; data: Record<string, unknown> };

function io(answer: Answer | Error) {
  const out: string[] = [];
  const err: string[] = [];
  const calls: { method: string; path: string }[] = [];
  const x: ApprovalsIo = {
    out: (s) => void out.push(s),
    err: (s) => void err.push(s),
    api: async (method, path) => {
      calls.push({ method, path });
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
  return { x, out, err, calls };
}

const ID = "abcdefghijklmnop";

describe("issue 1293: approvals withdraw", () => {
  it("withdrawn: exit 0, through the asker's own route", async () => {
    const t = io({
      status: 200,
      data: { ok: true, id: ID, state: "withdrawn", summary: "create north" },
    });
    expect(await cmdApprovals(["withdraw", ID], t.x)).toBe(0);
    expect(t.calls).toEqual([
      { method: "POST", path: `/api/approvals/${ID}/withdraw` },
    ]);
    expect(t.out.join("\n")).toContain(`Withdrawn: ${ID}`);
  });

  it.each([
    [409, "already_decided", "This request was already decided (denied at …)."],
    [410, "expired", "This request waited too long; it ended at …."],
    [410, "lost", "This request was lost at a restart (…). Nothing ran."],
  ])(
    "already ended (%s %s): exit 0, and it says how",
    async (status, code, error) => {
      const t = io({ status, data: { ok: false, code, error } });
      expect(await cmdApprovals(["withdraw", ID], t.x)).toBe(0);
      expect(t.out.join("\n")).toContain(`Already ended: ${error}`);
      expect(t.err).toEqual([]);
    },
  );

  it.each([
    [403, "not_asker", "Only the one that asked may withdraw a request."],
    [404, "not_found", "No such request (it may have ended at a restart)."],
  ])("%s %s: exit 1 with the reason", async (status, code, error) => {
    const t = io({ status, data: { ok: false, code, error } });
    expect(await cmdApprovals(["withdraw", ID], t.x)).toBe(1);
    expect(t.err.join("\n")).toContain(error);
  });

  it("Den didn't answer: exit 1", async () => {
    const t = io(new Error("connect refused"));
    expect(await cmdApprovals(["withdraw", ID], t.x)).toBe(1);
    expect(t.err.join("\n")).toContain("didn't answer");
  });

  it("no id, a bad id, or an extra word: usage, exit 2, nothing sent", async () => {
    for (const args of [
      ["withdraw"],
      ["withdraw", "../x"],
      ["withdraw", ID, "more"],
      ["nope"],
      [],
    ]) {
      const t = io({ status: 200, data: { ok: true } });
      expect(await cmdApprovals(args, t.x)).toBe(2);
      expect(t.calls).toEqual([]);
    }
  });
});

describe("issue 1293: approvals list --mine", () => {
  it("lists the caller's waiting requests only, with the claim when there is one", async () => {
    const t = io({
      status: 200,
      data: {
        ok: true,
        mine: [
          {
            id: ID,
            action: "workspace_create",
            summary: 'create the workspace "north"',
            state: "pending",
            claimedAs: "agent:helper",
          },
          {
            id: "qrstuvwxyzabcdef",
            action: "workspace_create",
            summary: 'create the workspace "south"',
            state: "withdrawn",
          },
        ],
      },
    });
    expect(await cmdApprovals(["list", "--mine"], t.x)).toBe(0);
    expect(t.calls).toEqual([{ method: "GET", path: "/api/approvals?mine=1" }]);
    const text = t.out.join("\n");
    expect(text).toContain(ID);
    expect(text).toContain('create the workspace "north"');
    expect(text).toContain("as agent:helper (not verified)");
    expect(text).not.toContain("south");
  });

  it("none waiting: says so, exit 0", async () => {
    const t = io({ status: 200, data: { ok: true, mine: [] } });
    expect(await cmdApprovals(["list", "--mine"], t.x)).toBe(0);
    expect(t.out.join("\n")).toContain("No waiting requests of yours.");
  });

  it("refused: exit 1 with the reason", async () => {
    const t = io({
      status: 403,
      data: { ok: false, error: "Sign in to see your requests." },
    });
    expect(await cmdApprovals(["list", "--mine"], t.x)).toBe(1);
    expect(t.err.join("\n")).toContain("Sign in to see your requests.");
  });

  it("list without --mine: usage, exit 2", async () => {
    const t = io({ status: 200, data: { ok: true } });
    expect(await cmdApprovals(["list"], t.x)).toBe(2);
    expect(t.calls).toEqual([]);
  });
});
