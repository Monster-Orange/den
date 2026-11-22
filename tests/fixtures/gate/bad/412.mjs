// Skip reasons the harness refuses: not "person" or "needs-<thing>" (fixture).
export const issue = 412;
export const clauses = ["a clause"];
const NO_HUB = "needs a test Hub";
export async function setup(ctx) {
  if (!ctx.hub) return { skip: "needs ctx.hub" };
  return {};
}
export async function run(_ctx, s) {
  if (s.skip) return s;
  return {
    skip: NO_HUB,
    ok: { skip: "needs-two-hubs" },
    p: { skip: "person" },
  };
}
export function expect(result) {
  return [{ clause: clauses[0], ok: null, skip: result.skip }];
}
