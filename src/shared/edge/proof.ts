/**
 * H1 (0.4.48): the edge's proof. A secret only Den and its edge know: the
 * edge adds it to every request it forwards to Den's own web route
 * (EDGE_PROOF_HEADER, a Traefik headers middleware), and Den believes the
 * edge's forwarded client (X-Forwarded-For) only with it. Without it a
 * request on the edge hostname is never this machine: it signs in.
 *
 * 32 random bytes as hex, 0600, in the edge's state folder (edge.stateDir,
 * beside dynamic/, which is the only part the container mounts; the
 * generated dynamic file, 000-den.yml, carries it for Traefik). Never logged, never in
 * doctor output, Report payloads or a service print: only its file path and
 * whether it is there are ever said.
 */
import { randomBytes, timingSafeEqual } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { writeFileAtomic } from "../atomic-write.js";

/** The request header the edge adds (Den deletes it once read). */
export const EDGE_PROOF_HEADER = "x-den-edge-proof";

const PROOF_RE = /^[0-9a-f]{64}$/;

export const edgeProofFile = (edgeStateDir: string): string =>
  path.join(edgeStateDir, "den-edge-proof");

/** The proof, or null when there is none (or the file isn't one). */
export function readEdgeProof(stateDir: string): string | null {
  try {
    const p = fs.readFileSync(edgeProofFile(stateDir), "utf8").trim();
    return PROOF_RE.test(p) ? p : null;
  } catch {
    return null;
  }
}

/**
 * The proof generation. Raising it makes every install's proof new on the
 * first start (or edge up) of the version that raised it: a proof made
 * under an older generation, or with none recorded (before 2), is replaced
 * once. Raise it when a proof may have been seen by something other than
 * Den and its edge.
 */
export const EDGE_PROOF_GENERATION = 2;

/** Beside the proof: the generation it was made under. */
export const edgeProofGenerationFile = (edgeStateDir: string): string =>
  `${edgeProofFile(edgeStateDir)}.generation`;

/** Whether the proof here was made under the current generation. */
export function proofIsCurrent(stateDir: string): boolean {
  try {
    const g = fs.readFileSync(edgeProofGenerationFile(stateDir), "utf8");
    return Number(g.trim()) >= EDGE_PROOF_GENERATION;
  } catch {
    return false;
  }
}

function writeProof(stateDir: string): string {
  const p = randomBytes(32).toString("hex");
  const f = edgeProofFile(stateDir);
  fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
  writeFileAtomic(f, p + "\n", { mode: 0o600 });
  // After the proof: a stop in between makes a new one again next time.
  writeFileAtomic(
    edgeProofGenerationFile(stateDir),
    `${EDGE_PROOF_GENERATION}\n`,
    { mode: 0o600 },
  );
  return p;
}

/**
 * The proof, made the first time (edge up), or made again when it is from
 * an older generation (proofIsCurrent).
 */
export function ensureEdgeProof(stateDir: string): string {
  const have = readEdgeProof(stateDir);
  return have && proofIsCurrent(stateDir) ? have : writeProof(stateDir);
}

/** A new proof (`edge up --rotate-proof`): the old one stops matching. */
export function rotateEdgeProof(stateDir: string): string {
  return writeProof(stateDir);
}

/** Whether `given` is exactly `proof`, in constant time. */
export function proofMatches(
  given: string | undefined,
  proof: string | null,
): boolean {
  if (!proof || typeof given !== "string") return false;
  const a = Buffer.from(given);
  const b = Buffer.from(proof);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Beside the proof: present while Den holds the edge's trust back (an edge
 * with Traefik's API on that couldn't be stopped or recreated, edge/start.ts),
 * with the reason. While it is there no proof proves; a successful `edge up`
 * removes it.
 */
export const edgeTrustHeldFile = (edgeStateDir: string): string =>
  path.join(edgeStateDir, "edge-trust-held.json");

/** Hold the edge's trust back, saying why (throws when it can't be written). */
export function holdEdgeTrust(stateDir: string, reason: string): void {
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  writeFileAtomic(
    edgeTrustHeldFile(stateDir),
    JSON.stringify({ reason, at: new Date().toISOString() }) + "\n",
    { mode: 0o600 },
  );
}

/** End a hold (none: nothing to do). */
export function releaseEdgeTrust(stateDir: string): void {
  fs.rmSync(edgeTrustHeldFile(stateDir), { force: true });
}

/** Why the edge's trust is held back, or null when it isn't. */
export function edgeTrustHeld(stateDir: string): string | null {
  let text: string;
  try {
    text = fs.readFileSync(edgeTrustHeldFile(stateDir), "utf8");
  } catch {
    return null;
  }
  try {
    const r = (JSON.parse(text) as { reason?: unknown }).reason;
    return typeof r === "string" && r ? r : "held back";
  } catch {
    return "held back";
  }
}

/** A request as the checker needs it (http.IncomingMessage fits). */
interface ProofRequest {
  headers: Record<string, string | string[] | undefined>;
}

/**
 * H1: the web server's check, per request. The header is read once and
 * taken off the request (it never reaches a log, a Report or a proxied
 * service); the answer is kept for the request's later checks. The proof
 * file is re-read when it or its generation file changes (a rotation
 * renames a new file in), so an old proof fails on the very next request.
 * A proof of an older generation (proofIsCurrent) proves nothing, before
 * the server's start replaces it or when it can't (a read-only store):
 * the rotation fails closed. While the edge's trust is held back
 * (edgeTrustHeld) nothing proves either. `dir`: the edge's state folder, or
 * null (no edge: nothing proves).
 */
export function edgeProofChecker(
  dir: () => string | null,
): (req: ProofRequest) => boolean {
  const seen = new WeakMap<ProofRequest, boolean>();
  let cache: { key: string; proof: string | null } = { key: "", proof: null };
  const current = (): string | null => {
    const d = dir();
    if (!d) return null;
    if (fs.existsSync(edgeTrustHeldFile(d))) return null;
    let key: string;
    try {
      const st = fs.statSync(edgeProofFile(d));
      key = `${d}:${st.ino}:${st.mtimeMs}:${st.size}`;
    } catch {
      return null;
    }
    try {
      const g = fs.statSync(edgeProofGenerationFile(d));
      key += `:${g.ino}:${g.mtimeMs}:${g.size}`;
    } catch {
      key += ":-";
    }
    if (key !== cache.key)
      cache = { key, proof: proofIsCurrent(d) ? readEdgeProof(d) : null };
    return cache.proof;
  };
  return (req) => {
    const known = seen.get(req);
    if (known !== undefined) return known;
    const h = req.headers[EDGE_PROOF_HEADER];
    delete req.headers[EDGE_PROOF_HEADER];
    const ok = typeof h === "string" && proofMatches(h, current());
    seen.set(req, ok);
    return ok;
  };
}
