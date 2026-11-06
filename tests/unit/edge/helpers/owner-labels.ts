/**
 * The edge container's owner labels (`den.edge.root`, `den.edge.org`,
 * 0.3.0-dev.40) came after the golden files: those are older engines' own
 * bytes. Byte comparisons drop exactly this block and nothing else; the
 * labels themselves are asserted in render.test.ts.
 */
const OWNER_LABELS =
  /^ {4}labels:\n {6}den\.edge\.root: [^\n]*\n {6}den\.edge\.org: [^\n]*\n/m;

export function withoutOwnerLabels(compose: string): string {
  if (!OWNER_LABELS.test(compose))
    throw new Error("the edge's owner labels are missing");
  return compose.replace(OWNER_LABELS, "");
}
