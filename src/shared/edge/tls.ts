/**
 * The edge's TLS strategies (TLS-1a), registered through the generic
 * strategy registry (src/shared/strategies/registry.ts) as kind "tls",
 * exactly as a plugin would register one: `{ id, kind, detect(),
 * capabilities }`.
 *
 *  - `none`: http only. No https entrypoint, no cert work, no mkcert.
 *  - `mkcert`: the edge issues its own wildcard cert from a local CA, its
 *    own under the state dir (minted on first use) or `ca`, an existing one
 *    it never mints or uninstalls. The only strategy with `trust`/`untrust`.
 *  - `files`: the distribution's included dynamic config and mounts hold the
 *    certs; Den issues none. `ca` names the CA that signed them, so health
 *    checks trust it.
 *
 * `secret` (cert and key from the selected secrets strategy) and `acme` are
 * later plugins; they register here the same way.
 *
 * Capabilities:
 *  - `https`: the edge has an https entrypoint;
 *  - `issuesCert`: Den issues the edge's own cert (the TLS store it renders);
 *  - `ensure(cfg)`: make sure the cert exists for certNames(cfg);
 *  - `trust(cfg)` / `untrust(cfg)`: mkcert only;
 *  - `status(cfg)`: the names on the cert and whether its CA is trusted.
 */
import * as fs from "fs";
import * as path from "path";
import {
  getStrategy,
  onPath,
  registerStrategy,
  strategyIds,
  type DetectResult,
  type StrategyEntry,
} from "../strategies/registry.js";
import { must, sh } from "./exec.js";
import { certNames } from "./render.js";
import type { EdgeConfig, EdgeTls } from "./types.js";

export const TLS_KIND = "tls";

export type TlsEnsureResult =
  | {
      kind: "cert";
      certFile: string;
      keyFile: string;
      issued: boolean;
      names: string[];
    }
  | { kind: "dynamic" | "none"; issued: false; names: [] };

export interface TlsCapabilities {
  label: string;
  https: boolean;
  issuesCert: boolean;
  ensure(cfg: EdgeConfig): TlsEnsureResult;
  trust?(cfg: EdgeConfig): number;
  untrust?(cfg: EdgeConfig): number;
  status(cfg: EdgeConfig): { names: string[]; trusted: boolean | null };
}

export type TlsStrategy = StrategyEntry<typeof TLS_KIND, TlsCapabilities>;

// ── The CA ───────────────────────────────────────────────────────────────────

/** The configured CA (`edge.tls.ca`, formerly `edge.caroot`), or null. */
export function tlsCa(cfg: EdgeConfig): string | null {
  return cfg.tls.strategy === "none" ? null : cfg.tls.ca;
}

export function caDir(cfg: EdgeConfig): string {
  return tlsCa(cfg) ?? path.join(cfg.stateDir, "ca");
}

/** True when the edge uses an existing CA (`ca`) rather than its own. */
export function sharedCa(cfg: EdgeConfig): boolean {
  return tlsCa(cfg) !== null;
}

/**
 * A shared CA must already exist with its key: mkcert silently creates a new
 * CA in an empty CAROOT, and devices that trust the shared one would not
 * trust that. The org's own CA may be created on first use.
 */
export function assertCaUsable(cfg: EdgeConfig): void {
  if (!sharedCa(cfg)) return;
  const dir = caDir(cfg);
  if (!fs.existsSync(dir))
    throw new Error(
      `edge.tls.ca ${dir} does not exist. The edge never creates a CA there; ` +
        `point it at the existing CA (\`mkcert -CAROOT\`).`,
    );
  for (const f of ["rootCA.pem", "rootCA-key.pem"])
    if (!fs.existsSync(path.join(dir, f)))
      throw new Error(
        `edge.tls.ca ${dir} has no ${f}. Refusing to run: mkcert would mint a ` +
          `new CA that other devices don't trust.`,
      );
}

/** Whether the CA is in the macOS system keychain (null: can't tell). */
export function caTrusted(cfg: EdgeConfig): boolean | null {
  if (cfg.tls.strategy === "none") return null;
  const pem = path.join(caDir(cfg), "rootCA.pem");
  if (!fs.existsSync(pem)) return false;
  if (process.platform !== "darwin") return null;
  return sh("security", ["verify-cert", "-c", pem]).code === 0;
}

// ── mkcert ───────────────────────────────────────────────────────────────────

export const MKCERT_MISSING = "mkcert is not installed";

/** detect() first: a missing mkcert is a reason, never a spawn error. */
function requireMkcert(): void {
  const d = mkcert.detect();
  if (!d.available)
    throw new Error(
      `${d.reason}. Install it (https://github.com/FiloSottile/mkcert, e.g. ` +
        "`brew install mkcert`), or set edge.tls to none or files.",
    );
}

function mkcertEnv(cfg: EdgeConfig): NodeJS.ProcessEnv {
  return { CAROOT: caDir(cfg) };
}

const NO_CERT = { issued: false, names: [] } as const;

const none: TlsStrategy = {
  id: "none",
  kind: TLS_KIND,
  detect: () => ({ available: true, reason: "http only" }),
  capabilities: {
    label: "none (http only)",
    https: false,
    issuesCert: false,
    ensure: () => ({ kind: "none", ...NO_CERT, names: [] }),
    status: () => ({ names: [], trusted: null }),
  },
};

const mkcert: TlsStrategy = {
  id: "mkcert",
  kind: TLS_KIND,
  detect: (env: NodeJS.ProcessEnv = process.env): DetectResult =>
    onPath("mkcert", env)
      ? { available: true }
      : { available: false, reason: MKCERT_MISSING },
  capabilities: {
    label: "mkcert",
    https: true,
    issuesCert: true,
    /** Issue (or re-issue when names changed) the edge cert from the CA. */
    ensure(cfg) {
      const names = certNames(cfg);
      assertCaUsable(cfg);
      const dir = path.join(cfg.stateDir, "certs");
      const certFile = path.join(dir, "edge.pem");
      const keyFile = path.join(dir, "edge-key.pem");
      const stamp = path.join(dir, "names.txt");
      const want = names.join("\n");
      if (
        fs.existsSync(certFile) &&
        fs.existsSync(stamp) &&
        fs.readFileSync(stamp, "utf-8") === want
      )
        return { kind: "cert", certFile, keyFile, issued: false, names };
      requireMkcert();
      fs.mkdirSync(dir, { recursive: true });
      if (!sharedCa(cfg))
        fs.mkdirSync(caDir(cfg), { recursive: true, mode: 0o700 });
      must("mkcert", ["-cert-file", certFile, "-key-file", keyFile, ...names], {
        env: mkcertEnv(cfg),
      });
      fs.mkdirSync(path.dirname(stamp), { recursive: true });
      fs.writeFileSync(stamp, want, "utf-8");
      return { kind: "cert", certFile, keyFile, issued: true, names };
    },
    /** Install the CA into the system + browser trust stores (prompts). */
    trust(cfg) {
      assertCaUsable(cfg);
      requireMkcert();
      if (!sharedCa(cfg))
        fs.mkdirSync(caDir(cfg), { recursive: true, mode: 0o700 });
      return sh("mkcert", ["-install"], { env: mkcertEnv(cfg), inherit: true })
        .code;
    },
    untrust(cfg) {
      if (sharedCa(cfg))
        throw new Error(
          `edge.tls.ca is a shared CA (${caDir(cfg)}); other tools and devices ` +
            `rely on it being trusted, so the edge never uninstalls it.`,
        );
      requireMkcert();
      return sh("mkcert", ["-uninstall"], {
        env: mkcertEnv(cfg),
        inherit: true,
      }).code;
    },
    status: (cfg) => ({ names: certNames(cfg), trusted: caTrusted(cfg) }),
  },
};

const files: TlsStrategy = {
  id: "files",
  kind: TLS_KIND,
  detect: () => ({ available: true }),
  capabilities: {
    label: "files (included config)",
    https: true,
    issuesCert: false,
    ensure: () => ({ kind: "dynamic", ...NO_CERT, names: [] }),
    status: (cfg) => ({ names: [], trusted: caTrusted(cfg) }),
  },
};

for (const s of [none, mkcert, files]) registerStrategy(s);

/** Every registered TLS strategy id (built-ins first). */
export function tlsStrategyIds(): string[] {
  return strategyIds(TLS_KIND);
}

/** The registered TLS strategy `id`, or undefined. */
export function tlsStrategy(id: string): TlsStrategy | undefined {
  return getStrategy<typeof TLS_KIND, TlsCapabilities>(TLS_KIND, id);
}

/** The strategy the edge config selects (always registered once parsed). */
export function tlsStrategyFor(cfg: EdgeConfig): TlsStrategy {
  const s = tlsStrategy(cfg.tls.strategy);
  if (!s)
    throw new Error(`TLS strategy "${cfg.tls.strategy}" is not registered`);
  return s;
}

/** True when the edge serves https (every strategy but none). */
export function servesHttps(cfg: EdgeConfig): boolean {
  return cfg.tls.strategy !== "none";
}

/** True when Den issues the edge's own cert (mkcert). */
export function issuesCert(cfg: EdgeConfig): boolean {
  return cfg.tls.strategy === "mkcert";
}

const TRUST_NEEDS_MKCERT =
  "edge trust needs edge.tls.strategy: mkcert (or files with a ca)";

function trustRefusal(cfg: EdgeConfig, verb: "trust" | "untrust"): Error {
  return new Error(
    `${TRUST_NEEDS_MKCERT.replace("trust", verb)} (this edge's is ${cfg.tls.strategy}: ` +
      (cfg.tls.strategy === "none"
        ? "it serves http only, there is no CA to trust)."
        : "its certs come from your included config; trust their CA yourself)."),
  );
}

/**
 * Trust capabilities for the edge: mkcert's own, or, for `files` with an
 * existing `ca` (the legacy caroot + issue_cert: false shape), mkcert's
 * against that CA: `edge trust` installs it, as caroot always did, and
 * untrust refuses it as a shared CA.
 */
function trustCapabilities(cfg: EdgeConfig): TlsCapabilities | null {
  const c = tlsStrategyFor(cfg).capabilities;
  if (c.trust) return c;
  if (cfg.tls.strategy === "files" && sharedCa(cfg)) return mkcert.capabilities;
  return null;
}

/** `edge trust`: mkcert, or files with an existing ca. */
export function edgeTrust(cfg: EdgeConfig): number {
  const t = trustCapabilities(cfg)?.trust;
  if (!t) throw trustRefusal(cfg, "trust");
  return t(cfg);
}

/** `edge untrust`: mkcert only, and never for a shared CA. */
export function edgeUntrust(cfg: EdgeConfig): number {
  const u = trustCapabilities(cfg)?.untrust;
  if (!u) throw trustRefusal(cfg, "untrust");
  return u(cfg);
}

// ── Config warnings ──────────────────────────────────────────────────────────

export const IMPLICIT_TLS_WARNING =
  "edge.tls is not set; defaulting to mkcert with a local CA. Set edge.tls explicitly.";

/** The explicit `edge.tls` line that says what `tls` says. */
export function tlsYaml(tls: EdgeTls): string {
  if (tls.strategy === "none") return "tls: none";
  const ca = tls.ca ? `, ca: ${tls.ca}` : "";
  if (tls.strategy === "mkcert") return `tls: { strategy: mkcert${ca} }`;
  return `tls: { strategy: files${ca}, include: <edge.include>, mounts: <edge.mounts> }`;
}

/** Config warnings about the edge's TLS, for `validate` and `doctor`. */
export function edgeTlsWarnings(cfg: EdgeConfig): string[] {
  if (cfg.tlsFrom === "implicit") return [IMPLICIT_TLS_WARNING];
  if (cfg.tlsFrom === "legacy")
    return [
      "edge.caroot and edge.issue_cert are deprecated; they still work. " +
        `Say the same with edge.${tlsYaml(cfg.tls)}`,
    ];
  return [];
}

let warnedImplicit = false;

/**
 * The implicit-mkcert warning, at most once per run: from `validate` and
 * from the paths that would mint a cert (`edge up`, `stack up`).
 */
export function warnImplicitTlsOnce(
  cfg: EdgeConfig,
  warn: (line: string) => void = (l) => console.warn(`⚠️  ${l}`),
): void {
  if (cfg.tlsFrom !== "implicit" || warnedImplicit) return;
  warnedImplicit = true;
  warn(IMPLICIT_TLS_WARNING);
}

/** Test seam: forget that the warning was given. */
export function __resetTlsWarningForTests(): void {
  warnedImplicit = false;
}
