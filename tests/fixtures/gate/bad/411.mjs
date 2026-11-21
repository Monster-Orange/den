// A plain fetch from the host against the browser's address (fixture).
export const issue = 411;
export const clauses = ["a clause"];
export async function setup() {
  return {};
}
export async function run(ctx) {
  const a = await fetch(new URL("/api/session", ctx.url), {
    headers: { accept: "application/json" },
  });
  const b = await fetch(`${ctx.url}/api/session`);
  return { a: a.status, b: b.status };
}
export function expect(result) {
  return [{ clause: clauses[0], ok: result.a === 200 && result.b === 200 }];
}
