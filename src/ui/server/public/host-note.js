/**
 * Issue 500: what Terminal says about the terminal host, from the list
 * (GET /api/sessions). No DOM here, so it runs without a browser
 * (tests/unit/sessions/host-version.test.ts).
 *
 *   stuck   it doesn't answer, or can't start a shell: the reason and its
 *           version, with a Restart
 *   older   it runs an older version than this Den: restart it when
 *           you're done, with a Restart
 *
 * null: nothing to say.
 */
const v = (x) => (x ? `v${x}` : null);

export function hostNote(data) {
  if (!data) return null;
  if (data.hostStuck)
    return {
      kind: "stuck",
      vars: {
        host: v(data.hostStuck.version),
        why: String(data.hostStuck.reason ?? ""),
      },
    };
  const hv = data.hostVersion;
  if (hv?.older)
    return { kind: "older", vars: { host: v(hv.host), den: v(hv.den) } };
  return null;
}
