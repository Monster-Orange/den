/**
 * Issue 1215: a live check's own project, made as the fixture person on a
 * test install and removed at the end, even when the check throws. For a
 * clause that needs a project set up (a long name, to see how a row
 * truncates). The fixture person may change only the projects it made, and
 * deletes them without removing any folder or clone.
 *
 *   await withFixtureProject(ctx, "a very long project name", async (slug) => {
 *     // ... the check, against the project `slug`
 *   });
 *
 * Not a live check itself: the bed runs only gate/<issue>.mjs, not this
 * folder.
 */

const json = (method, body) => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

/** `{ status, body }` from ctx.fetch, with the body parsed if it's text. */
async function call(ctx, path, init) {
  const r = await ctx.fetch(path, init);
  let body = r?.body;
  if (typeof body === "string")
    try {
      body = JSON.parse(body);
    } catch {
      /* not JSON: kept as text */
    }
  return { status: r?.status, body: body ?? {} };
}

/**
 * Makes the project `name`, runs `fn(slug)`, then deletes it (stopping any
 * agents the check started in it). The check's own error wins; a failed
 * delete after a passing check throws, so a project never stays behind
 * silently.
 */
export async function withFixtureProject(ctx, name, fn) {
  const made = await call(
    ctx,
    "/api/workspaces/create",
    json("POST", { name }),
  );
  if (made.status !== 200 || typeof made.body.slug !== "string")
    throw new Error(
      `couldn't make the project ${JSON.stringify(name)} as the fixture person: ${made.status} ${made.body.code ?? made.body.error ?? ""}`.trim(),
    );
  const slug = made.body.slug;
  let failed = false;
  try {
    return await fn(slug);
  } catch (e) {
    failed = true;
    throw e;
  } finally {
    const gone = await call(
      ctx,
      "/api/workspaces",
      json("DELETE", { name: slug, agents: "stop" }),
    ).catch((e) => ({ status: String(e?.message ?? e), body: {} }));
    if (gone.status !== 200 && !failed)
      // eslint-disable-next-line no-unsafe-finally
      throw new Error(
        `couldn't delete the project "${slug}" after the check: ${gone.status} ${gone.body.code ?? ""}`.trim(),
      );
  }
}
