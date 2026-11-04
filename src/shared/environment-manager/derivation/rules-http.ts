/**
 * Rule B — synchronous service dependencies (HTTP / JWKS).
 *
 * Three corroborating signals, all caller→callee:
 *   - SDK imports: go.mod / package.json / pyproject.toml referencing a peer's SDK.
 *   - env URLs: *_API_URL / *_SERVICE_URL / *_JWKS_URL / *_URL whose key token or
 *     value host resolves to a peer (matched via the alias map).
 *   - IaC stack refs: Pulumi `pulumi_<svc>_project_name` / `<svc>__internal_dns_hostname`.
 *
 * All edges are emitted `soft` here; blocking is finalized in derive-graph via the
 * central `edges:` override (the source of truth for functional-hard edges).
 */

import type { AliasResolver } from "./alias.js";
import type {
  Confidence,
  DerivedEdge,
  EdgeKind,
  ScannedFile,
  ScannedRepo,
} from "./types.js";
import { evidenceAt, isCommentedLine, lineNumberAt } from "./text.js";

const SDK_FILES = /(^|\/)(package\.json|go\.mod|pyproject\.toml)$/;
const ENV_FILES = /(^|\/)(stack\.yml|\.env)/;
const IAC_FILE = /\.py$/;

// Longer suffixes first so e.g. SHOP_BACKEND_INTERNAL_URL → token "shop-backend".
const URL_KEY =
  /\b([A-Z0-9_]+?)_(API_URL|SERVICE_URL|JWKS_URL|BASE_URL|INTERNAL_URL|ENDPOINT_URL|ENDPOINT|URL|HOST|BASE)\b/g;
const URL_VALUE = /https?:\/\/([a-z0-9][a-z0-9.-]*)/g;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** `github.com/<org>/<repo>` for any configured SDK org (none → never matches). */
const goSdk = (orgs: string[]) =>
  orgs.length
    ? new RegExp(
        `github\\.com\\/(?:${orgs.map(escapeRe).join("|")})\\/([a-z0-9-]+)`,
        "g",
      )
    : null;
/** `@<scope>/<pkg>` for any configured npm scope (none → never matches). */
const npmSdk = (scopes: string[]) =>
  scopes.length
    ? new RegExp(`@(?:${scopes.map(escapeRe).join("|")})\\/([a-z0-9-]+)`, "g")
    : null;
const PY_SDK = /\b([a-z][a-z0-9-]*-(?:sdk|events|client))\b/g;
const PULUMI_REF =
  /(?:pulumi_([a-z0-9_]+)_(?:project_name|stack_name)|([a-z0-9_]+)__internal_dns_hostname)/g;

interface Candidate {
  token: string;
  kind: EdgeKind;
  signal: string;
  index: number;
  confidence: Confidence;
}

/** matchAll results always carry an index; this just narrows the type. */
const at = (m: RegExpMatchArray): number => m.index ?? 0;

/**
 * The assigned value on the line containing `index` — text after the first
 * `:` or `=`, trimmed, surrounding quotes stripped. `""`, `KEY:`, and
 * `KEY=` all read as empty.
 */
function lineValueAt(content: string, index: number): string {
  const start = content.lastIndexOf("\n", index - 1) + 1;
  let end = content.indexOf("\n", index);
  if (end === -1) end = content.length;
  const line = content.slice(start, end);
  const sep = line.search(/[:=]/);
  if (sep === -1) return "";
  return line
    .slice(sep + 1)
    .trim()
    .replace(/^["']|["']$/g, "")
    .trim();
}

/**
 * Compact evidence for an SDK-import edge: `<file>:<line>  <name> <version>`
 * instead of the raw line — npm SDK deps resolve to a long api-specs `.tgz`
 * URL that swamps the graph. The version is the last semver-ish token on the
 * line (works for `…-0.2.18.tgz`, go `v0.2.6`, and npm `^1.2.3`).
 */
function sdkEvidence(file: ScannedFile, index: number, token: string): string {
  const start = file.content.lastIndexOf("\n", index - 1) + 1;
  let end = file.content.indexOf("\n", index);
  if (end === -1) end = file.content.length;
  const line = file.content.slice(start, end);
  // Core semver + optional hyphenated pre-release only — a hyphen won't attach
  // a file extension the way `[-.]` did (`…-0.1.14.tgz` → "0.1.14", not
  // "0.1.14.tgz"), while `1.2.3-rc1` is still captured whole.
  const versions = line.match(/\d+\.\d+(?:\.\d+)?(?:-[A-Za-z0-9.]+)?/g);
  const version = versions?.[versions.length - 1];
  return `${file.rel}:${lineNumberAt(file.content, index)}  ${token}${version ? ` ${version}` : ""}`;
}

/**
 * go.mod hygiene: only DIRECT `require` entries are real dependencies. Skips
 * transitive modules (`// indirect`) and `replace`/`exclude` directive lines —
 * a replace target is a local override, not a new callee.
 */
function isDirectGoRequire(content: string, index: number): boolean {
  const start = content.lastIndexOf("\n", index - 1) + 1;
  let end = content.indexOf("\n", index);
  if (end === -1) end = content.length;
  const line = content.slice(start, end);
  if (/\/\/\s*indirect\b/.test(line)) return false;
  const head = line.trimStart();
  return (
    !head.startsWith("replace") &&
    !head.startsWith("exclude") &&
    !line.includes("=>")
  );
}

function pushEdge(
  out: DerivedEdge[],
  repo: ScannedRepo,
  alias: AliasResolver,
  file: ScannedFile,
  c: Candidate,
): void {
  const to = alias.resolve(c.token);
  if (!to || to === repo.repoName || to === alias.infraRepo) return;
  if (isCommentedLine(file.content, c.index)) return; // skip commented-out config
  out.push({
    from: repo.repoName,
    to,
    kind: c.kind,
    blocking: "soft",
    signal: c.signal,
    evidence:
      c.signal === "http:sdk-import"
        ? sdkEvidence(file, c.index, c.token)
        : evidenceAt(file, c.index),
    confidence: c.confidence,
  });
}

function scanFile(
  out: DerivedEdge[],
  repo: ScannedRepo,
  alias: AliasResolver,
  file: ScannedFile,
): void {
  const add = (c: Candidate) => pushEdge(out, repo, alias, file, c);

  if (SDK_FILES.test(file.rel)) {
    const NPM_SDK = npmSdk(alias.npmScopes);
    const GO_SDK = goSdk(alias.sdkOrgs);
    if (NPM_SDK)
      for (const m of file.content.matchAll(NPM_SDK))
        add({
          token: m[1],
          kind: "http",
          signal: "http:sdk-import",
          index: at(m),
          confidence: "high",
        });
    if (GO_SDK)
      for (const m of file.content.matchAll(GO_SDK)) {
        if (
          file.rel.endsWith("go.mod") &&
          !isDirectGoRequire(file.content, at(m))
        )
          continue;
        add({
          token: m[1],
          kind: "http",
          signal: "http:sdk-import",
          index: at(m),
          confidence: "high",
        });
      }
    if (file.rel.endsWith("pyproject.toml"))
      for (const m of file.content.matchAll(PY_SDK))
        add({
          token: m[1],
          kind: "http",
          signal: "http:sdk-import",
          index: at(m),
          confidence: "high",
        });
  }

  if (ENV_FILES.test(file.rel)) {
    // stack.yml declares keys once with an EMPTY value (`SHOP_JWKS_URL:`) and
    // fills them in per-env sections below. Group matches per key and cite the
    // first occurrence that actually carries a value, so the graph evidence
    // reads `TOKEN_SERVICE_URL: http://tokens` instead of a bare key.
    const bestByKey = new Map<string, RegExpMatchArray>();
    for (const m of file.content.matchAll(URL_KEY)) {
      if (isCommentedLine(file.content, at(m))) continue;
      const cur = bestByKey.get(m[0]);
      if (!cur) {
        bestByKey.set(m[0], m);
      } else if (
        lineValueAt(file.content, at(cur)) === "" &&
        lineValueAt(file.content, at(m)) !== ""
      ) {
        bestByKey.set(m[0], m);
      }
    }
    for (const m of bestByKey.values()) {
      const kind: EdgeKind = m[2].includes("JWKS") ? "jwks" : "http";
      add({
        token: m[1],
        kind,
        signal: "http:env-url",
        index: at(m),
        confidence: "high",
      });
    }
    for (const m of file.content.matchAll(URL_VALUE)) {
      const host = m[1].split(/[.:]/)[0];
      add({
        token: host,
        kind: "http",
        signal: "http:env-url",
        index: at(m),
        confidence: "medium",
      });
    }
  }

  if (IAC_FILE.test(file.rel)) {
    for (const m of file.content.matchAll(PULUMI_REF))
      add({
        token: m[1] ?? m[2],
        kind: "http",
        signal: "http:iac-stack-ref",
        index: at(m),
        confidence: "medium",
      });
  }
}

export function deriveHttpEdges(
  repo: ScannedRepo,
  alias: AliasResolver,
): DerivedEdge[] {
  const out: DerivedEdge[] = [];
  for (const file of repo.files) scanFile(out, repo, alias, file);
  return out;
}
