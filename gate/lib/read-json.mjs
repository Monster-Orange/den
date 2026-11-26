
export function maskTokens(text) {
  return String(text ?? "")
    .replace(/\b(Bearer|Basic|Token)\s+\S+/gi, "$1 [REDACTED]")
    .replace(
      /\b(token|secret|password|passwd|api[_-]?key|authorization|cookie)(["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;&'"}\]]+)/gi,
      "$1$2[REDACTED]",
    )
    .replace(/[A-Za-z0-9_\-.~+/=]{20,}/g, "[REDACTED]");
}

const said = (r) =>
  JSON.stringify(maskTokens(String(r?.out ?? "").slice(0, 200))) +
  (r?.err
    ? `; stderr ${JSON.stringify(maskTokens(String(r.err).slice(0, 200)))}`
    : "");

export function readJson(r, what, { codes = [0] } = {}) {
  const code = r?.code ?? null;
  if (!codes.includes(code))
    throw new Error(`${what} --json exited ${code}: ${said(r)}`);
  try {
    return JSON.parse(String(r?.out ?? ""));
  } catch {
    throw new Error(
      `${what} --json did not print JSON (exit ${code}): ${said(r)}`,
    );
  }
}

export function doctorChecks(r) {
  const j = readJson(r, "doctor", { codes: [0, 1] });
  if (!Array.isArray(j?.checks) || j.checks.length === 0)
    throw new Error(`doctor --json printed no checks: ${said(r)}`);
  return j.checks;
}
