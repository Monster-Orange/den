/**
 * Issue 476: where a review leg hands its findings to Den.
 *
 *   POST /api/agents/self/review-submit   a Submission (runner.ts)
 *
 * Which agent is asking comes from its actor token (agentPrincipalOf),
 * never the body. With no agent token the request is refused and audited.
 * The body is checked here, at the boundary: a bad shape is a 400 and
 * never reaches the runner. The runner then accepts it only from the
 * session Den started for that leg, PR and head (legs.ts).
 */
import type * as http from "http";
import { z } from "zod";
import type { LegRefusal } from "../../shared/review/mesh/legs.js";
import type { Submission } from "../../shared/review/mesh/runner.js";
import type { Outcome } from "../../shared/review/mesh/outcome.js";
import { readBody, sendJson } from "./http-helpers.js";
import { agentPrincipalOf, type AgentPrincipal } from "./request-guard.js";

export const REVIEW_SUBMIT_PATH = "/api/agents/self/review-submit";

const MAX_BODY = 1_000_000;

/** A path in the repo: relative, no climbing out, no odd characters. */
const repoPath = z
  .string()
  .min(1)
  .max(500)
  .refine(
    (p) =>
      !p.startsWith("/") &&
      !p.split("/").some((s) => s === ".." || s === "") &&
      !/[\0\r\n]/.test(p),
    "a path inside the repo",
  );

const marker = z.string().regex(/^[A-Za-z0-9_.:-]{1,64}$/);

const submissionSchema = z
  .object({
    leg: z.string().regex(/^[a-f0-9]{32}$/),
    repo: z
      .string()
      .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
      .refine((r) => !r.includes(".."), "owner/name"),
    pr: z.number().int().positive(),
    sha: z.string().regex(/^[0-9a-f]{40}$/),
    verdict: z.string().max(4000),
    findings: z
      .array(
        z
          .object({
            id: marker,
            path: repoPath,
            line: z.number().int().positive(),
            severity: z.enum(["high", "medium", "low"]),
            lens: marker,
            blocking: z.boolean(),
            body: z.string().min(1).max(20_000),
          })
          .strip(),
      )
      .max(200),
    depth: z.string().max(40),
    model: z.string().max(80),
    tokens: z.number().int().min(0).nullable(),
    costUsd: z.number().min(0).nullable(),
  })
  .strip();

export interface ReviewRouteDeps {
  runner: () => {
    submit(
      who: { agent: string | undefined; verified: boolean },
      sub: Submission,
    ): Promise<{ ok: true; outcome: Outcome } | { ok: false; why: LegRefusal }>;
  };
  audit: (a: {
    why: LegRefusal;
    agent: string | undefined;
    repo: string;
    pr: number;
  }) => void;
  /** Tests pass one; the server reads the request's actor token. */
  principal?: (req: http.IncomingMessage) => AgentPrincipal | null;
}

const STATUS: Partial<Record<LegRefusal, number>> = {
  unverified_actor: 403,
  wrong_agent: 403,
  unknown_leg: 404,
  wrong_pr: 409,
  wrong_head: 409,
  expired: 410,
  already_submitted: 409,
};

export async function handleReviewRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  d: ReviewRouteDeps,
): Promise<boolean> {
  if (pathname !== REVIEW_SUBMIT_PATH) return false;
  if ((req.method ?? "GET").toUpperCase() !== "POST") {
    sendJson(res, { ok: false, code: "method", error: "POST only." }, 405);
    return true;
  }
  const p = (d.principal ?? agentPrincipalOf)(req);
  let raw = "";
  try {
    raw = await readBody(req);
  } catch {
    raw = "";
  }
  let parsed: unknown = null;
  try {
    parsed = raw.length <= MAX_BODY ? JSON.parse(raw) : null;
  } catch {
    parsed = null;
  }
  if (!p) {
    const b = (parsed ?? {}) as { repo?: unknown; pr?: unknown };
    d.audit({
      why: "unverified_actor",
      agent: undefined,
      repo: typeof b.repo === "string" ? b.repo.slice(0, 200) : "",
      pr: typeof b.pr === "number" ? b.pr : 0,
    });
    sendJson(
      res,
      {
        ok: false,
        code: "unverified_actor",
        error:
          "review_submit is a review leg's: only the agent Den started for the review may call it.",
      },
      403,
    );
    return true;
  }
  const sub = submissionSchema.safeParse(parsed);
  if (!sub.success) {
    sendJson(
      res,
      {
        ok: false,
        code: "bad_request",
        error: `review_submit: ${sub.error.issues[0]?.path.join(".") || "body"} ${sub.error.issues[0]?.message ?? "is not valid"}`,
      },
      400,
    );
    return true;
  }
  const r = await d
    .runner()
    .submit(
      { agent: p.actor.slice("agent:".length), verified: true },
      sub.data as Submission,
    );
  if (r.ok) sendJson(res, r);
  else
    sendJson(
      res,
      {
        ok: false,
        code: r.why,
        error: `review_submit refused: ${r.why.replace(/_/g, " ")}.`,
      },
      STATUS[r.why] ?? 400,
    );
  return true;
}
