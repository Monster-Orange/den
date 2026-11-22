// Host fetches use ctx.hostUrl; the browser's address stays in the browser (fixture).
export const issue = 411;
export const clauses = ["a clause"];
export async function setup() {
  return {};
}
export async function run(ctx) {
  const a = await fetch(new URL("/api/session", ctx.hostUrl));
  await ctx.page.goto(new URL("/agents", ctx.url).href);
  const b = await ctx.page.evaluate(async () => {
    const r = await fetch("/api/session");
    return r.status;
  });
  return { a: a.status, b };
}
export function expect(result) {
  return [{ clause: clauses[0], ok: result.a === 200 && result.b === 200 }];
}
