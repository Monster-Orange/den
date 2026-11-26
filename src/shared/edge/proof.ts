/**
 * H1 (0.4.48): the edge's proof. A secret only Den and its edge know: the
 * edge adds it to every request it forwards to Den's own web route
 * (EDGE_PROOF_HEADER, a Traefik headers middleware), and Den believes the
 * edge's forwarded client (X-Forwarded-For) only with it. Without it a
 * request on the edge hostname is never this machine: it signs in.
 *
 * 32 random bytes as hex, 0600, in the edge's state folder (edge.stateDir,
 * beside dynamic/, which is the only part the container mounts; the
 * generated dynamic/edge.yml carries it for Traefik). Never logged, never in
 * doctor output, Report payloads or a service print: only its file path and
 * whether it is there are ever said.
 */
import { randomBytes, timingSafeEqual } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { writeFileAtomic } from "../atomic-write.js";
import { statSettled } from "../stat-settled.js";

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

function writeProof(stateDir: string): string {
  const p = randomBytes(32).toString("hex");
  const f = edgeProofFile(stateDir);
  fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
  writeFileAtomic(f, p + "\n", { mode: 0o600 });
  return p;
}

/** The proof, made the first time (edge up). */
export function ensureEdgeProof(stateDir: string): string {
  return readEdgeProof(stateDir) ?? writeProof(stateDir);
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

/** A request as the checker needs it (http.IncomingMessage fits). */
interface ProofRequest {
  headers: Record<string, string | string[] | undefined>;
}

/**
 * H1: the web server's check, per request. The header is read once and
 * taken off the request (it never reaches a log, a Report or a proxied
 * service); the answer is kept for the request's later checks. The proof
 * file is re-read when it changes (a rotation renames a new file in), so
 * an old proof fails on the very next request. `dir`: the edge's state
 * folder, or null (no edge: nothing proves).
 */
export function edgeProofChecker(
  dir: () => string | null,
): (req: ProofRequest) => boolean {
  const seen = new WeakMap<ProofRequest, boolean>();
  let cache: { key: string; proof: string | null; readAt: number } = {
    key: "",
    proof: null,
    readAt: 0,
  };
  const current = (): string | null => {
    const d = dir();
    if (!d) return null;
    let key: string;
    // When it last changed, to judge whether its stat has settled.
    let changed: { mtimeMs: number; ctimeMs: number };
    try {
      const st = fs.statSync(edgeProofFile(d));
      key = `${d}:${st.ino}:${st.mtimeMs}:${st.ctimeMs}:${st.size}`;
      changed = { mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs };
    } catch {
      return null;
    }
    // Kept only while its stat stays the same, and only once it was
    // written more than a clock tick before the read: a proof
    // rewritten in one tick (a rename onto a reused inode) is read again.
    if (key !== cache.key || !statSettled(changed, cache.readAt)) {
      const readAt = Date.now();
      cache = { key, proof: readEdgeProof(d), readAt };
    }
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
