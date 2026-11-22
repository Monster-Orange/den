/**
 * Issue 441: an outside runner's gate results, imported as a Verify run.
 *
 * A runner that runs a repo's live checks (`gate/<issue>.mjs`, the shape
 * in CONTRIBUTING.md, "Live checks") writes one verdict file per build:
 *
 *   { tag, sha?, startedAt, endedAt,
 *     clauses: [{ issue, clause, verdict PASS|FAIL|NOT_RUN|ERROR, ms, note? }] }
 *
 * `<cli> verify import <file> --env <env>` keeps it as a normal run record
 * on an environment Verify alone knows (the org config's
 * `verify.environments`): the tag is the run's id, each gate file is one
 * check (`gate/<issue>`) holding its clauses.
 *
 * The file is untrusted: it is checked against a schema, with a size and a
 * count cap (settings), long texts are cut, and evidence paths are dropped
 * (a later step serves them from under the import's own folder).
 *
 *   verify:
 *     environments: [bed]            default none
 *     import: { max_bytes: 5000000, max_clauses: 5000, max_text: 2000 }
 *
 * These are the `verify:` keys this file reads (IMPORT_KEYS); the run,
 * flaky, history and security keys belong to the run settings' reader.
 */
import { z } from "zod";
import type { RunActor, RunRecord } from "./records.js";
import { VERDICT_EXIT, type ModuleRun } from "./run.js";

/** The `verify:` keys this reader owns. */
export const IMPORT_KEYS = ["environments", "import"] as const;

export interface ImportSettings {
  /** Environments Verify shows and imports into; nothing else in Den sees them. */
  environments: string[];
  maxBytes: number;
  maxClauses: number;
  /** The longest clause name or note kept, in characters. */
  maxText: number;
}

export const IMPORT_DEFAULTS: Readonly<ImportSettings> = {
  environments: [],
  maxBytes: 5_000_000,
  maxClauses: 5000,
  maxText: 2000,
};

const ENV_RE = /^[a-z0-9][a-z0-9._-]{0,39}$/;
/** A run's id (records.ts): the tag must be one. */
const RUN_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};

function whole(v: unknown, name: string, fallback: number): number {
  if (v === undefined || v === null) return fallback;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1)
    throw new Error(
      `verify.import.${name}: a whole number, 1 or more (got ${JSON.stringify(v)})`,
    );
  return v;
}

/** `verify:` from the org config: the import's part, defaults filled in. */
export function readImportSettings(raw: unknown): ImportSettings {
  const v = obj(raw);
  const d = IMPORT_DEFAULTS;
  let environments = d.environments;
  const asMap = obj(v.environments);
  if (Object.keys(asMap).length) {
    // Issue 214: the map form (VERIFY-SPEC section 6), with `imported: true`.
    const names = Object.keys(asMap);
    const bad = names.find((e) => !ENV_RE.test(e));
    if (bad)
      throw new Error(
        `verify.environments: environment names are lowercase letters, digits, . _ -, got ${JSON.stringify(bad)}`,
      );
    environments = names.filter((e) => obj(asMap[e]).imported === true);
  } else if (v.environments !== undefined && v.environments !== null) {
    if (
      !Array.isArray(v.environments) ||
      !v.environments.every((e) => typeof e === "string" && ENV_RE.test(e))
    )
      throw new Error(
        `verify.environments: a list of environment names (lowercase letters, digits, . _ -), got ${JSON.stringify(v.environments)}`,
      );
    environments = [...new Set(v.environments as string[])];
  }
  const imp = obj(v.import);
  return {
    environments,
    maxBytes: whole(imp.max_bytes, "max_bytes", d.maxBytes),
    maxClauses: whole(imp.max_clauses, "max_clauses", d.maxClauses),
    maxText: whole(imp.max_text, "max_text", d.maxText),
  };
}

export type ClauseResult =
  | "passed"
  | "failed"
  | "error"
  | "needs-person"
  | "cant-run";

export interface GateClause {
  issue: string;
  clause: string;
  verdict: "PASS" | "FAIL" | "NOT_RUN" | "ERROR";
  ms: number | null;
  note: string;
}

export interface GateVerdict {
  tag: string;
  sha: string | null;
  startedAt: string;
  endedAt: string;
  clauses: GateClause[];
}

const ISO = z
  .string()
  .max(40)
  .refine((s) => Number.isFinite(Date.parse(s)), "an ISO time");

const SCHEMA = z.object({
  tag: z.string().regex(RUN_RE, "tag: a run id (letters, digits, . _ -)"),
  sha: z
    .string()
    .regex(/^[0-9a-f]{7,64}$/i)
    .nullish(),
  startedAt: ISO,
  endedAt: ISO,
  clauses: z.array(
    z.object({
      issue: z.union([
        z.number().int().nonnegative(),
        z.string().regex(/^[A-Za-z0-9._-]{1,40}$/),
      ]),
      clause: z.string().min(1),
      verdict: z.enum(["PASS", "FAIL", "NOT_RUN", "ERROR"]),
      ms: z.number().nonnegative().nullish(),
      note: z.string().nullish(),
    }),
  ),
});

/** One line, at most `max` characters. Text only: never markup. */
const cut = (s: string, max: number) =>
  s.replace(/\s+/g, " ").trim().slice(0, max);

/** A runner's verdict file, checked; never trusted past this. */
export function parseGateVerdict(
  text: string,
  lim: ImportSettings,
): { ok: true; verdict: GateVerdict } | { ok: false; error: string } {
  if (Buffer.byteLength(text, "utf8") > lim.maxBytes)
    return {
      ok: false,
      error: `the file is over ${lim.maxBytes} bytes (verify.import.max_bytes)`,
    };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: "the file is not JSON" };
  }
  const n = Array.isArray(obj(raw).clauses)
    ? (obj(raw).clauses as unknown[]).length
    : 0;
  if (n > lim.maxClauses)
    return {
      ok: false,
      error: `the file has ${n} clauses, over ${lim.maxClauses} (verify.import.max_clauses)`,
    };
  const p = SCHEMA.safeParse(raw);
  if (!p.success) {
    const i = p.error.issues[0];
    return {
      ok: false,
      error: `not a gate verdict: ${i.path.join(".") || "the file"}: ${i.message}`,
    };
  }
  return {
    ok: true,
    verdict: {
      tag: p.data.tag,
      sha: p.data.sha ?? null,
      startedAt: p.data.startedAt,
      endedAt: p.data.endedAt,
      clauses: p.data.clauses.map((c) => ({
        issue: String(c.issue),
        clause: cut(c.clause, lim.maxText),
        verdict: c.verdict,
        ms: c.ms ?? null,
        note: cut(c.note ?? "", lim.maxText),
      })),
    },
  };
}

/** A clause as a check keeps it. */
export interface ClauseRecord {
  clause: string;
  result: ClauseResult;
  note?: string;
  ms?: number;
}

/**
 * A NOT_RUN's reason: the runner's note without its "skip: …" tail; with
 * no other words, the skip itself in words ("needs-second-device" → "needs
 * second device"). Its result: a person's act, or what the bed lacks.
 */
function notRun(note: string): { result: ClauseResult; note: string } {
  const m = /(?:^|\s·\s|\s)skip:\s*([A-Za-z0-9-]+)\s*$/.exec(note);
  const skip = m?.[1] ?? "";
  const words = (m ? note.slice(0, m.index) : note).trim();
  return {
    result: skip === "person" ? "needs-person" : "cant-run",
    note: words || skip.replace(/-/g, " "),
  };
}

const RESULT: Record<GateClause["verdict"], ClauseResult> = {
  PASS: "passed",
  FAIL: "failed",
  ERROR: "error",
  NOT_RUN: "cant-run",
};

function clauseOf(c: GateClause): ClauseRecord {
  const r =
    c.verdict === "NOT_RUN"
      ? notRun(c.note)
      : { result: RESULT[c.verdict], note: c.note };
  return {
    clause: c.clause,
    result: r.result,
    ...(r.note ? { note: r.note } : {}),
    ...(c.ms !== null ? { ms: c.ms } : {}),
  };
}

const RUNNER: RunActor = { kind: "runner" };

/** The run record an import keeps: one check per gate file. */
export function importRecord(
  project: string,
  env: string,
  v: GateVerdict,
): RunRecord {
  const byIssue = new Map<string, GateClause[]>();
  for (const c of v.clauses) {
    const l = byIssue.get(c.issue) ?? [];
    l.push(c);
    byIssue.set(c.issue, l);
  }
  const modules = [...byIssue.entries()].map(([issue, cs]) => {
    const clauses = cs.map(clauseOf);
    const first = (r: ClauseResult) => clauses.find((c) => c.result === r);
    const line = (c: ClauseRecord) =>
      c.note ? `${c.clause}: ${c.note}` : c.clause;
    const failed = first("failed");
    const error = first("error");
    const ran = clauses.some((c) => c.result === "passed");
    const state: ModuleRun["state"] = error
      ? "error"
      : failed
        ? "failed"
        : ran
          ? "passed"
          : "blocked";
    const message =
      state === "error"
        ? line(error!)
        : state === "failed"
          ? line(failed!)
          : state === "blocked"
            ? `nothing ran here: ${clauses[0]?.clause ?? ""}`
            : undefined;
    const ms = Math.max(0, ...clauses.map((c) => c.ms ?? 0));
    return {
      id: `gate/${issue}`,
      name: `gate/${issue}`,
      repo: "",
      layer: "gate",
      kind: "synthetic",
      mark: "imported",
      state,
      ...(message ? { message } : {}),
      ms,
      clauses,
    };
  });
  const bad = modules.some((m) => m.state === "failed" || m.state === "error");
  const ran = modules.some((m) => m.state === "passed");
  const verdict = bad ? "failed" : ran ? "passed" : "nothing ran";
  return {
    runId: v.tag,
    project,
    env,
    scope: "imported",
    source: "import",
    verdict,
    exitCode: VERDICT_EXIT[verdict],
    startedAt: v.startedAt,
    endedAt: v.endedAt,
    startedBy: RUNNER,
    commit: v.sha,
    modules,
  };
}
