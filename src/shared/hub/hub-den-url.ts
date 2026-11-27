/**
 * Issue 869: after every change of this install's address (a person's
 * save, a held write's Allow, the one-time migration writing or
 * correcting it), Den tells the connected Hub with its install token:
 * PUT <hub>/api/installs/self/den-url {url}.
 *
 *   200          Hub took it ({changed: true}) or had it ({changed: false})
 *   400/401/403  Hub refused: recorded in the activity trail, and shown on
 *                Settings › Hub until a later tell goes through
 *   404          an older Hub with no such route: skipped quietly, with an
 *                activity row
 *   no answer    recorded in the activity trail
 *
 * The address save never fails because of Hub: this never throws, and
 * callers don't wait on it.
 */
import * as fs from "fs";
import * as path from "path";
import { auditConfig } from "../config-audit.js";
import { writeFileAtomic } from "../atomic-write.js";

export const DEN_URL_TELL_FILE = "hub-den-url.json";

export type DenUrlOutcome =
  | "changed"
  | "unchanged"
  | "refused"
  | "old_hub"
  | "unreachable"
  | "not_connected";

export interface DenUrlTell {
  /** ISO time it was told. */
  at: string;
  url: string;
  outcome: DenUrlOutcome;
  /** Hub's HTTP status, when it answered one. */
  status?: number;
  /** Hub's words for a refusal, or why it didn't answer. */
  error?: string;
  hub?: string;
}

export interface DenUrlTellDeps {
  /** The connected Hub's address and install token; null: none. */
  hub: () => Promise<{ url: string; token: string } | null>;
  /** PUT /api/installs/self/den-url; throws HubCallError on a refusal. */
  put: (hubUrl: string, token: string, denUrl: string) => Promise<unknown>;
  stateDir: string;
  now?: () => Date;
}

const printable = (v: unknown, max = 200): string =>
  String(v ?? "")
    .replace(/[^\x20-\x7e]/g, "?")
    .slice(0, max);

const originOf = (u: string | null | undefined): string | null => {
  try {
    return u ? new URL(u).origin : null;
  } catch {
    return null;
  }
};

const OWED = new Set<DenUrlOutcome>([
  "refused",
  "unreachable",
  "not_connected",
]);

export function denUrlTellDue(
  t: DenUrlTell | null,
  denUrl: string | null | undefined,
  hubUrl: string | null | undefined,
): boolean {
  const hub = originOf(hubUrl);
  if (!denUrl || !hub) return false;
  if (!t || t.url !== denUrl || originOf(t.hub) !== hub) return true;
  return OWED.has(t.outcome);
}

export function denUrlTellRow(
  t: DenUrlTell | null,
  denUrl: string | null | undefined,
  hubUrl: string | null | undefined,
): { detail: string } | null {
  if (!denUrlTellDue(t, denUrl, hubUrl)) return null;
  const last =
    t && originOf(t.hub) === originOf(hubUrl) && t.url === denUrl
      ? `; the last try: ${printable(t.outcome, 40)}${typeof t.status === "number" ? ` (${t.status})` : ""}${t.error ? `: ${printable(t.error)}` : ""}`
      : "";
  return {
    detail: `Hub doesn't know this Den's address yet (${denUrl}). Den tells it again at the next project sync${last}`,
  };
}

export async function retryDenUrlTell(
  d: DenUrlTellDeps & { denUrl: () => string | null | undefined },
): Promise<DenUrlTell | null> {
  const denUrl = d.denUrl();
  if (!denUrl) return null;
  let at: { url: string; token: string } | null = null;
  try {
    at = await d.hub();
  } catch {
    at = null;
  }
  if (!at || !denUrlTellDue(readDenUrlTell(d.stateDir), denUrl, at.url))
    return null;
  const got = at;
  return tellHubDenUrl(denUrl, { ...d, hub: async () => got });
}

export function denUrlTellPath(stateDir: string): string {
  return path.join(stateDir, DEN_URL_TELL_FILE);
}

/** The last tell, or null (none, or unreadable). */
export function readDenUrlTell(stateDir: string): DenUrlTell | null {
  try {
    const v = JSON.parse(
      fs.readFileSync(denUrlTellPath(stateDir), "utf-8"),
    ) as DenUrlTell;
    return v && typeof v.outcome === "string" && typeof v.url === "string"
      ? v
      : null;
  } catch {
    return null;
  }
}

/** What Settings › Hub shows: a refusal only (400, 401, 403). */
export function denUrlTellProblem(t: DenUrlTell | null): DenUrlTell | null {
  return t && t.outcome === "refused" ? t : null;
}

function errInfo(e: unknown): { status?: number; message: string } {
  const o = (e ?? {}) as {
    status?: unknown;
    kind?: unknown;
    message?: unknown;
  };
  const status =
    typeof o.status === "number"
      ? o.status
      : o.kind === "rejected"
        ? 401
        : o.kind === "forbidden"
          ? 403
          : undefined;
  return {
    ...(status !== undefined ? { status } : {}),
    message: printable(typeof o.message === "string" ? o.message : String(e)),
  };
}

/** Tell Hub `denUrl`; records what came of it. Never throws. */
export async function tellHubDenUrl(
  denUrl: string,
  d: DenUrlTellDeps,
): Promise<DenUrlTell> {
  const at = (d.now ?? (() => new Date()))().toISOString();
  let tell: DenUrlTell;
  let at_: { url: string; token: string } | null = null;
  try {
    at_ = await d.hub();
  } catch {
    at_ = null;
  }
  if (!at_) return { at, url: denUrl, outcome: "not_connected" };
  try {
    const b = (await d.put(at_.url, at_.token, denUrl)) as {
      changed?: unknown;
    } | null;
    tell = {
      at,
      url: denUrl,
      outcome: b && b.changed === false ? "unchanged" : "changed",
      status: 200,
    };
  } catch (e) {
    const { status, message } = errInfo(e);
    tell =
      status === 404
        ? { at, url: denUrl, outcome: "old_hub", status }
        : status === 400 || status === 401 || status === 403
          ? { at, url: denUrl, outcome: "refused", status, error: message }
          : {
              at,
              url: denUrl,
              outcome: "unreachable",
              ...(status !== undefined ? { status } : {}),
              error: message,
            };
  }
  const told = originOf(at_.url);
  if (told) tell = { ...tell, hub: told };
  const detail =
    tell.outcome === "changed"
      ? `told Hub this Den's address: ${denUrl}`
      : tell.outcome === "unchanged"
        ? `told Hub this Den's address: ${denUrl} (Hub had it)`
        : tell.outcome === "old_hub"
          ? `didn't tell Hub this Den's address (${denUrl}): this Hub is older and doesn't take it`
          : `couldn't tell Hub this Den's address (${denUrl})`;
  const failed = tell.outcome === "refused" || tell.outcome === "unreachable";
  auditConfig(
    {
      verb: "hub-den-url",
      detail,
      ...(failed
        ? {
            outcome: "refused" as const,
            reason: `${tell.status ?? "no answer"}: ${tell.error ?? ""}`.trim(),
          }
        : {}),
    },
    d.stateDir,
  );
  try {
    writeFileAtomic(
      denUrlTellPath(d.stateDir),
      JSON.stringify(tell, null, 2) + "\n",
      { mode: 0o600 },
    );
  } catch {
    /* best effort: the activity trail has it */
  }
  return tell;
}
