/**
 * Issue 476: POST /api/agents/self/review-submit, where a review leg hands
 * its findings to Den. Which agent is asking comes from its actor token,
 * never the body. A request with no agent token is refused and audited.
 * The body is checked at the boundary: a bad shape is a 400 and never
 * reaches the runner.
 */
import { describe, expect, it } from "@jest/globals";
import { Readable } from "stream";
import type * as http from "http";
import {
  handleReviewRoutes,
  REVIEW_SUBMIT_PATH,
} from "../../../src/ui/server/review-routes.js";
import type { Submission } from "../../../src/shared/review/mesh/runner.js";

function req(method: string, body?: unknown): http.IncomingMessage {
  const raw = typeof body === "string" ? body : JSON.stringify(body ?? {});
  const r = Readable.from([
    Buffer.from(raw),
  ]) as unknown as http.IncomingMessage;
  (r as { method?: string }).method = method;
  return r;
}
function res() {
  const out = { status: 0, body: undefined as unknown };
  const r = {
    writeHead(s: number) {
      out.status = s;
      return r;
    },
    setHeader() {},
    end(b?: string) {
      out.body = b ? JSON.parse(b) : undefined;
    },
  } as unknown as http.ServerResponse;
  return { r, out };
}

const SHA = "a".repeat(40);
const good = {
  leg: "f".repeat(32),
  repo: "octo/app",
  pr: 3,
  sha: SHA,
  verdict: "One finding.",
  findings: [
    {
      id: "f-1",
      path: "src/a.ts",
      line: 4,
      severity: "high",
      lens: "correctness",
      blocking: true,
      body: "Off by one.",
    },
  ],
  depth: "standard",
  model: "claude-opus-5-5",
  tokens: 1000,
  costUsd: null,
};

function setup(principal: unknown) {
  const calls: { who: unknown; sub: Submission }[] = [];
  const audits: unknown[] = [];
  const deps = {
    runner: () => ({
      submit: async (who: unknown, sub: Submission) => {
        calls.push({ who, sub });
        return { ok: true as const, outcome: "converged" as const };
      },
    }),
    audit: (a: unknown) => audits.push(a),
    principal: () => principal as never,
  };
  return { deps, calls, audits };
}

const agent = {
  kind: "agent",
  actor: "agent:rev-1",
  workspace: "den",
  grants: [],
  session: { name: "rev-1" },
};

describe("review_submit's route", () => {
  it("passes the token's agent and the checked body to the runner", async () => {
    const s = setup(agent);
    const { r, out } = res();
    expect(
      await handleReviewRoutes(
        req("POST", { ...good, agent: "someone-else" }),
        r,
        REVIEW_SUBMIT_PATH,
        s.deps,
      ),
    ).toBe(true);
    expect(out.status).toBe(200);
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0].who).toEqual({ agent: "rev-1", verified: true });
    expect(s.calls[0].sub.findings[0].path).toBe("src/a.ts");
    expect(s.calls[0].sub).not.toHaveProperty("agent");
  });

  it("no agent token: refused, audited, never submitted", async () => {
    const s = setup(null);
    const { r, out } = res();
    await handleReviewRoutes(req("POST", good), r, REVIEW_SUBMIT_PATH, s.deps);
    expect(out.status).toBe(403);
    expect(s.calls).toHaveLength(0);
    expect(s.audits).toEqual([
      expect.objectContaining({ why: "unverified_actor" }),
    ]);
  });

  it("a bad body is a 400 and never reaches the runner", async () => {
    const bad: unknown[] = [
      "not json",
      { ...good, sha: "main" },
      { ...good, repo: "../x" },
      {
        ...good,
        findings: [{ ...good.findings[0], path: "../../etc/passwd" }],
      },
      { ...good, findings: [{ ...good.findings[0], line: 0 }] },
      { ...good, findings: [{ ...good.findings[0], severity: "urgent" }] },
      {
        ...good,
        findings: [{ ...good.findings[0], body: "x".repeat(20_001) }],
      },
      { ...good, findings: Array(201).fill(good.findings[0]) },
    ];
    for (const b of bad) {
      const s = setup(agent);
      const { r, out } = res();
      await handleReviewRoutes(req("POST", b), r, REVIEW_SUBMIT_PATH, s.deps);
      expect(out.status).toBe(400);
      expect(s.calls).toHaveLength(0);
    }
  });

  it("another path is not this route's", async () => {
    const s = setup(agent);
    const { r } = res();
    expect(
      await handleReviewRoutes(req("POST", good), r, "/api/other", s.deps),
    ).toBe(false);
  });
});
