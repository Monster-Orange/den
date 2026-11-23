/**
 * Issue 840: how a live check reads a CLI command's --json output. Never a
 * silent fallback: a crash, a line before the JSON, or nothing at all would
 * otherwise leave an empty list, and a clause that proves an absence ("no
 * failing row", "no token in it") would pass on nothing. So this throws, and
 * the bed reports every clause of the check as an error, never a pass.
 *
 * Not a live check itself: the bed runs only gate/<issue>.mjs, not this
 * folder.
 */

/** A short, one-line view of what the command printed. */
const said = (r) =>
  JSON.stringify(String(r?.out ?? "").slice(0, 200)) +
  (r?.err ? `; stderr ${JSON.stringify(String(r.err).slice(0, 200))}` : "");

/**
 * The parsed JSON a `ctx.cli([..., "--json"])` result printed. Throws when
 * the command exited non-zero (unless `codes` allows that exit, as doctor's
 * 1 for a failing row), or printed anything that isn't one JSON value.
 */
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

/**
 * doctor --json's checks. Doctor exits 1 when a row fails, and still prints
 * them all. An empty or missing list is an error: doctor always has rows.
 */
export function doctorChecks(r) {
  const j = readJson(r, "doctor", { codes: [0, 1] });
  if (!Array.isArray(j?.checks) || j.checks.length === 0)
    throw new Error(`doctor --json printed no checks: ${said(r)}`);
  return j.checks;
}
