/**
 * Secret redaction, in two forms:
 *
 * - Known values (`redactValues`, `containsValue`): a run holds the live
 *   secret it minted (a bearer token, an agent key) and strips or refuses
 *   that exact string. The journeys and security pillars use these.
 * - Secret-shaped values (`redactSecrets`): text from somewhere we don't
 *   control (service logs, command output) is scrubbed by pattern before it
 *   leaves Den, e.g. through the MCP server. Patterns err on the side of
 *   redacting: a hidden harmless value costs less than a leaked key.
 */

export const REDACTED = "[REDACTED]";

/** Replace every occurrence of each non-empty value in `text`. */
export function redactValues(
  text: string,
  values: readonly (string | undefined)[],
): string {
  let out = text;
  for (const v of values) if (v) out = out.split(v).join(REDACTED);
  return out;
}

/** Whether `text` contains any non-empty value. */
export function containsValue(
  text: string,
  values: readonly (string | undefined)[],
): boolean {
  return values.some((v) => !!v && text.includes(v));
}

/** Key names whose values are secrets (matched anywhere in the key). */
const SECRET_KEY =
  "[\\w.-]*(?:password|passwd|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|credentials?|cookie)[\\w.-]*";

interface Pattern {
  name: string;
  re: RegExp;
  replace: string | ((...m: string[]) => string);
}

/**
 * Order matters: whole blocks first, then structured forms (URLs, auth
 * headers), then bare token shapes, then generic key=value.
 */
export const SECRET_PATTERNS: readonly Pattern[] = [
  {
    name: "private-key block",
    re: /-----BEGIN ([A-Z0-9 ]*)PRIVATE KEY-----[\s\S]*?-----END \1PRIVATE KEY-----/g,
    replace: (_m, kind) =>
      `-----BEGIN ${kind}PRIVATE KEY-----${REDACTED}-----END ${kind}PRIVATE KEY-----`,
  },
  {
    // A block cut off by a tail window: redact to the end of the text.
    name: "private-key block (unterminated)",
    re: /-----BEGIN ([A-Z0-9 ]*)PRIVATE KEY-----(?![\s\S]*-----END)(?!\[REDACTED\])[\s\S]*$/g,
    replace: (_m, kind) => `-----BEGIN ${kind}PRIVATE KEY-----${REDACTED}`,
  },
  {
    name: "URL credentials",
    re: /\b([a-z][a-z0-9+.-]*:\/\/)([^\s:@/]+):([^\s@/]+)@/gi,
    replace: (_m, scheme, user, pass) =>
      pass === REDACTED ? _m : `${scheme}${user}:${REDACTED}@`,
  },
  {
    name: "bearer token",
    re: /\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
    replace: (_m, scheme) => `${scheme} ${REDACTED}`,
  },
  {
    name: "JWT",
    re: /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g,
    replace: REDACTED,
  },
  {
    name: "AWS access key id",
    re: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA|AIPA)[A-Z0-9]{16}\b/g,
    replace: REDACTED,
  },
  {
    name: "well-known token prefix",
    re: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|[sr]k_(?:live|test)_[A-Za-z0-9]{10,}|sk-[A-Za-z0-9_-]{20,})/g,
    replace: REDACTED,
  },
  {
    name: "key=value secret",
    re: new RegExp(
      `\\b(${SECRET_KEY})(["']?\\s*[:=]\\s*)(\\[REDACTED\\]|"[^"]*"|'[^']*'|[^\\s,;&'"}\\]]+)`,
      "gi",
    ),
    replace: (_m, key, sep, value) => {
      const q = value[0] === '"' || value[0] === "'" ? value[0] : "";
      return `${key}${sep}${q}${REDACTED}${q}`;
    },
  },
];

/** Redact every secret-shaped value in `text` (see SECRET_PATTERNS). */
export function redactSecrets(text: string): string {
  let out = text;
  for (const p of SECRET_PATTERNS) {
    const r = p.replace;
    out = typeof r === "string" ? out.replace(p.re, r) : out.replace(p.re, r);
  }
  return out;
}
