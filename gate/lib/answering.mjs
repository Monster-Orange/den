export async function isAnswering(ctx) {
  try {
    let b = await ctx.api("/api/notifications");
    if (b && typeof b.json === "function") b = await b.json();
    return Array.isArray(b?.groups);
  } catch {
    return false;
  }
}
