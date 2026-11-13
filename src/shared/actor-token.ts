/**
 * SEC-1c (SEC-1 spec §5): an agent's actor token.
 *
 * `agents start` (and resume) mints `den_at_<43 b64url>`: 32 random bytes,
 * handed to the agent's session as DEN_ACTOR_TOKEN and to nothing else.
 * The state dir keeps only its sha256 (`actor-tokens.json`, 0600, the dir
 * 0700), with what it proves:
 *
 *   { actor: "agent:<id>", workspace, grants, session: { name, id } }
 *
 * - One live token per agent: minting another (a resume, a restart)
 *   revokes the old one, so it stops working at once.
 * - Revoked when the agent stops (`agents stop`, the page's Stop), and when
 *   its session ends: a token verifies only while the session it was minted
 *   for is listed as running in the session host's own record
 *   (`sessions/<id>.json`); an ended one's token is removed when presented.
 * - It never derives from web.secret, so it proves nothing about the
 *   person. `web logout --all` (the "something leaked" button, SEC-1
 *   §6c.2) revokes every token as well as rotating the secret: each record
 *   is kept, marked `revokedAt`, so a running agent's next call is told
 *   `token_revoked` (restart or resume it) rather than a bare 401. Minting
 *   the agent's next token, or its session's end, drops the record.
 *
 * Nothing here prints or logs a token.
 */
import { createHash, randomBytes } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { AGENT_ACTOR_RE, WORKSPACE_NAME_RE } from "./agent-actor.js";
import { sessionPaths } from "./sessions/paths.js";

export const ACTOR_TOKEN_PREFIX = "den_at_";
/** The agent's session carries its token here (AG spec §5a-env). */
export const ACTOR_TOKEN_ENV = "DEN_ACTOR_TOKEN";
/** A person's token in an env: never forwarded to any session. */
export const PERSON_TOKEN_ENV = "DEN_PERSON_TOKEN";
export const ACTOR_TOKENS_FILE = "actor-tokens.json";

const TOKEN_RE = /^den_at_[A-Za-z0-9_-]{43}$/;
/** web-secret.ts's PERSON_TOKEN_PREFIX and WEB_SECRET_FILE (it imports this module). */
const PERSON_PREFIX = "den_pt_";
const SECRET_FILE = "web.secret";

export interface ActorTokenRecord {
  actor: `agent:${string}`;
  workspace: string;
  /** The agent's grants (agents.<id>.grants) when it was minted. */
  grants: string[];
  /** The session it was minted for: its name, and its id once started. */
  session: { name: string; id?: string };
  /** ISO 8601. */
  createdAt: string;
  /** ISO 8601: revoked by `web logout --all`. A revoked token never verifies. */
  revokedAt?: string;
}

interface StoreFile {
  v: 1;
  /** sha256(token), hex → what it proves. */
  tokens: Record<string, ActorTokenRecord>;
}

export function actorTokensPath(stateDir: string): string {
  return path.join(stateDir, ACTOR_TOKENS_FILE);
}

/** The token's key in the store: sha256, hex. */
export function actorTokenKey(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Shaped like an actor token (says nothing about whether it is live). */
export function isActorTokenShape(v: string | undefined): v is string {
  return typeof v === "string" && TOKEN_RE.test(v);
}

function load(stateDir: string): StoreFile {
  try {
    const raw = JSON.parse(
      fs.readFileSync(actorTokensPath(stateDir), "utf-8"),
    ) as Partial<StoreFile>;
    const tokens =
      raw.tokens && typeof raw.tokens === "object" && !Array.isArray(raw.tokens)
        ? raw.tokens
        : {};
    return { v: 1, tokens };
  } catch {
    return { v: 1, tokens: {} };
  }
}

function save(stateDir: string, data: StoreFile): void {
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const file = actorTokensPath(stateDir);
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

/**
 * A fresh token for agent `agentId`, its hash recorded, every older token
 * of the same agent revoked. The token itself is returned once and never
 * stored.
 */
export function mintActorToken(
  stateDir: string,
  o: {
    agentId: string;
    workspace: string;
    grants?: readonly string[];
    sessionName: string;
  },
): { token: string; key: string } {
  const actor = `agent:${o.agentId}` as const;
  if (!AGENT_ACTOR_RE.test(actor))
    throw new Error(`"${o.agentId}" is not an agent id`);
  if (!WORKSPACE_NAME_RE.test(o.workspace))
    throw new Error(`"${o.workspace}" is not a project name`);
  const token = ACTOR_TOKEN_PREFIX + randomBytes(32).toString("base64url");
  const key = actorTokenKey(token);
  const data = load(stateDir);
  for (const [k, r] of Object.entries(data.tokens))
    if (r.actor === actor) delete data.tokens[k];
  data.tokens[key] = {
    actor,
    workspace: o.workspace,
    grants: (o.grants ?? []).filter((g) => WORKSPACE_NAME_RE.test(g)),
    session: { name: o.sessionName },
    createdAt: new Date().toISOString(),
  };
  save(stateDir, data);
  return { token, key };
}

/** Bind a minted token to the session id the host gave its session. */
export function bindActorSession(
  stateDir: string,
  key: string,
  sessionId: string,
): void {
  const data = load(stateDir);
  const rec = data.tokens[key];
  if (!rec) return;
  rec.session = { ...rec.session, id: sessionId };
  save(stateDir, data);
}

/** Revoke one token (by its key). */
export function revokeActorToken(stateDir: string, key: string): boolean {
  const data = load(stateDir);
  if (!data.tokens[key]) return false;
  delete data.tokens[key];
  save(stateDir, data);
  return true;
}

/** Revoke every token of agent `agentId`; how many there were. */
export function revokeAgentTokens(stateDir: string, agentId: string): number {
  const data = load(stateDir);
  const actor = `agent:${agentId}`;
  let n = 0;
  for (const [k, r] of Object.entries(data.tokens))
    if (r.actor === actor) {
      delete data.tokens[k];
      n++;
    }
  if (n) save(stateDir, data);
  return n;
}

/**
 * Revoke every agent's token (`web logout --all`, SEC-1 §6c.2): each record
 * is marked revoked, so its agent learns why. How many were live.
 */
export function revokeAllActorTokens(stateDir: string): number {
  const data = load(stateDir);
  const now = new Date().toISOString();
  let n = 0;
  for (const r of Object.values(data.tokens))
    if (!r.revokedAt) {
      r.revokedAt = now;
      n++;
    }
  if (n) save(stateDir, data);
  return n;
}

/**
 * The agents whose token `web logout --all` revoked and whose record is
 * still kept (their session still runs): the Agents tab marks them, so a
 * person knows to restart or resume them (AG-4a-term). Ids only.
 */
export function revokedAgentIds(stateDir: string): Set<string> {
  const out = new Set<string>();
  for (const r of Object.values(load(stateDir).tokens))
    if (r.revokedAt && AGENT_ACTOR_RE.test(r.actor))
      out.add(r.actor.slice("agent:".length));
  return out;
}

/**
 * Whether agent `agentId` holds a token that isn't revoked: stopping it
 * deletes its tokens, `web logout --all` marks them revoked (ON-3: a held
 * write of an agent that is gone never runs).
 */
export function agentTokenLive(stateDir: string, agentId: string): boolean {
  const actor = `agent:${agentId}`;
  return Object.values(load(stateDir).tokens).some(
    (r) => r.actor === actor && !r.revokedAt,
  );
}

/** What a presented token was minted as, live or not; null when unknown. */
export function lookupActorToken(
  stateDir: string,
  token: string,
): ActorTokenRecord | null {
  if (!isActorTokenShape(token)) return null;
  return load(stateDir).tokens[actorTokenKey(token)] ?? null;
}

/** Whether the session host lists session `id` as running (its own record). */
export function sessionRunning(stateDir: string, id: string): boolean {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) return false;
  try {
    const rec = JSON.parse(
      fs.readFileSync(
        path.join(sessionPaths(stateDir).dir, `${id}.json`),
        "utf-8",
      ),
    ) as { exited?: unknown };
    return rec.exited !== true;
  } catch {
    return false;
  }
}

/**
 * What a presented token proves: its record; `"revoked"` when `web logout
 * --all` revoked it and its session still runs (the agent is told to
 * restart or resume); or null: unknown, not yet bound to a session, or its
 * session has ended (then its record is removed here).
 */
export function checkActorToken(
  stateDir: string,
  token: string,
): ActorTokenRecord | "revoked" | null {
  const rec = lookupActorToken(stateDir, token);
  if (!rec?.session.id) return null;
  if (!sessionRunning(stateDir, rec.session.id)) {
    try {
      revokeActorToken(stateDir, actorTokenKey(token));
    } catch {
      /* a read-only state dir: still refused */
    }
    return null;
  }
  return rec.revokedAt ? "revoked" : rec;
}

/** The record a presented token proves, or null (checkActorToken, revoked or not). */
export function verifyActorToken(
  stateDir: string,
  token: string,
): ActorTokenRecord | null {
  const r = checkActorToken(stateDir, token);
  return r === "revoked" ? null : r;
}

/**
 * A person's credential in an env (SEC-1 §5): DEN_PERSON_TOKEN, a value
 * shaped like a person token, or a value that names a web.secret file.
 * No session Den starts ever gets one, and `--keep-env` can't forward one.
 */
export function isPersonCredentialEnv(
  name: string,
  value: string | undefined,
): boolean {
  if (name === PERSON_TOKEN_ENV) return true;
  if (value === undefined) return false;
  const v = value.trim();
  if (v.includes(PERSON_PREFIX)) return true;
  return v
    .split(/[:;,\s]+/)
    .some((part) => path.basename(part.replace(/[/\\]+$/, "")) === SECRET_FILE);
}
