/**
 * Issue 785: `<cli> agents report-resume <conversation>` is how an agent's
 * runtime hook tells Den which conversation to resume after a restart.
 * It sends only { conversation, cwd, seq }, with the agent's own Den
 * token, and only to this Den. A bad id is refused before anything is
 * sent, so nothing that reads as a flag ever leaves the command.
 */
import { describe, expect, it } from "@jest/globals";
import { cmdReportResume } from "../../../src/ui/cli/report-resume-command.js";
import type { ServerIdentity } from "../../../src/ui/cli/server-identity.js";

const TOKEN = "den_at_TESTONLY0den785000agent0token00000000000";
const BASE = "http://127.0.0.1:4999";

interface Call {
  url: string;
  method: string;
  auth: string | undefined;
  body: unknown;
}

function harness(
  o: {
    token?: string | null;
    identity?: ServerIdentity["kind"];
    reply?: { status: number; body: unknown };
  } = {},
) {
  const calls: Call[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const env: Record<string, string | undefined> =
    o.token === null ? {} : { DEN_ACTOR_TOKEN: o.token ?? TOKEN };
  const deps = {
    env,
    out: (l: string) => void out.push(l),
    err: (l: string) => void err.push(l),
    cwd: () => "/work/north",
    now: () => 1_763_800_000_000,
    denBase: () => BASE,
    identify: async () =>
      ({ kind: o.identity ?? "ours", who: "other-den" }) as ServerIdentity,
    fetch: async (url: string, init: RequestInit) => {
      const h = new Headers(init.headers);
      calls.push({
        url,
        method: init.method ?? "GET",
        auth: h.get("authorization") ?? undefined,
        body: init.body ? JSON.parse(String(init.body)) : undefined,
      });
      const r = o.reply ?? {
        status: 200,
        body: { ok: true, kept: true, seq: 1 },
      };
      return new Response(JSON.stringify(r.body), {
        status: r.status,
        headers: { "content-type": "application/json" },
      });
    },
  };
  return { deps, calls, out, err };
}

describe("issue 785: agents report-resume", () => {
  it("sends only the conversation, the folder and a rising sequence, with the agent's token, to this Den", async () => {
    const h = harness();
    expect(await cmdReportResume(["019a-77"], h.deps)).toBe(0);
    expect(h.calls).toEqual([
      {
        url: `${BASE}/api/agents/self/resume-command`,
        method: "POST",
        auth: `Bearer ${TOKEN}`,
        body: {
          conversation: "019a-77",
          cwd: "/work/north",
          seq: 1_763_800_000_000,
        },
      },
    ]);
    expect(h.out.join("\n")).toMatch(/Den will resume conversation 019a-77/);
  });

  it("--cwd and --seq set the folder and the sequence", async () => {
    const h = harness();
    expect(
      await cmdReportResume(
        ["019a-77", "--cwd", "/work/south", "--seq", "42"],
        h.deps,
      ),
    ).toBe(0);
    expect(h.calls[0]!.body).toEqual({
      conversation: "019a-77",
      cwd: "/work/south",
      seq: 42,
    });
  });

  it("an id that reads as a flag, or with other words, is refused; nothing is sent", async () => {
    for (const bad of [["--sandbox"], ["-x"], ["a b"], ["019a;rm"], []]) {
      const h = harness();
      expect(await cmdReportResume(bad, h.deps)).toBe(2);
      expect(h.calls).toEqual([]);
    }
  });

  it("a sequence that isn't a whole number above 0 is refused; nothing is sent", async () => {
    for (const seq of ["0", "-3", "1.5", "x"]) {
      const h = harness();
      expect(await cmdReportResume(["019a-77", "--seq", seq], h.deps)).toBe(2);
      expect(h.calls).toEqual([]);
    }
  });

  it("outside an agent Den started (no token): says so; nothing is sent", async () => {
    const h = harness({ token: null });
    expect(await cmdReportResume(["019a-77"], h.deps)).toBe(2);
    expect(h.err.join("\n")).toMatch(/inside an agent Den started/);
    expect(h.calls).toEqual([]);
  });

  it("whatever answers is not this Den: the token is not sent", async () => {
    const h = harness({ identity: "foreign" });
    expect(await cmdReportResume(["019a-77"], h.deps)).toBe(1);
    expect(h.err.join("\n")).toMatch(/the agent's token was not sent/);
    expect(h.calls).toEqual([]);
  });

  it("Den refuses the report: its reason is shown, exit 1", async () => {
    const h = harness({
      reply: {
        status: 400,
        body: {
          ok: false,
          code: "held_elsewhere",
          error: "it is another agent's conversation",
        },
      },
    });
    expect(await cmdReportResume(["019a-77"], h.deps)).toBe(1);
    expect(h.err.join("\n")).toMatch(/it is another agent's conversation/);
  });

  it("an older report than the one Den keeps: not an error, says so", async () => {
    const h = harness({
      reply: { status: 200, body: { ok: true, kept: false, seq: 50 } },
    });
    expect(await cmdReportResume(["019a-77", "--seq", "3"], h.deps)).toBe(0);
    expect(h.out.join("\n")).toMatch(/newer/);
  });
});

describe("issue 785: agents report-resume --notify-json (Codex's notify)", () => {
  const turn = (o: Record<string, unknown> = {}) =>
    JSON.stringify({
      type: "agent-turn-complete",
      "thread-id": "019a7f2c-1b2d-7e3f-9a8b-0c1d2e3f4a5b",
      "turn-id": "t-9",
      cwd: "/work/north",
      "input-messages": ["plan the release"],
      "last-assistant-message": "done",
      ...o,
    });

  it("a finished turn: only its thread id and folder are reported", async () => {
    const h = harness();
    expect(await cmdReportResume(["--notify-json", turn()], h.deps)).toBe(0);
    expect(h.calls.map((c) => c.body)).toEqual([
      {
        conversation: "019a7f2c-1b2d-7e3f-9a8b-0c1d2e3f4a5b",
        cwd: "/work/north",
        seq: 1_763_800_000_000,
      },
    ]);
  });

  it("another kind of notice: nothing is sent, exit 0", async () => {
    const h = harness();
    expect(
      await cmdReportResume(
        ["--notify-json", turn({ type: "approval-requested" })],
        h.deps,
      ),
    ).toBe(0);
    expect(h.calls).toEqual([]);
  });

  it("not JSON, no thread id, an id that reads as a flag, or a relative folder: refused, nothing sent", async () => {
    for (const bad of [
      "not json",
      "[1,2]",
      turn({ "thread-id": undefined }),
      turn({ "thread-id": "--sandbox" }),
      turn({ "thread-id": 7 }),
      turn({ cwd: "work/north" }),
      turn({ cwd: undefined }),
    ]) {
      const h = harness();
      expect(await cmdReportResume(["--notify-json", bad], h.deps)).toBe(2);
      expect(h.calls).toEqual([]);
    }
  });

  it("with a conversation as well, or with no JSON: usage, nothing sent", async () => {
    for (const args of [
      ["019a-77", "--notify-json", turn()],
      ["--notify-json"],
    ]) {
      const h = harness();
      expect(await cmdReportResume(args, h.deps)).toBe(2);
      expect(h.calls).toEqual([]);
    }
  });
});
