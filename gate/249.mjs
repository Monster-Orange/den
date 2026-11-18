// Live check for issue 249: agents call Hub with their own bound token.
// One bed stub agent, gate-249-bound, removed at the end (and in teardown).
// Its turn end (Stop) asks Hub's inbox through Den's /hub proxy, as an
// agent's Stop hook does: the first Hub call for it, so Den asks Hub for
// its own token. Its row then says it is bound; the server agent's row
// never does (the install's token). Removing it takes its token out of
// the server's store. The check reads no token: only the row and the
// store's file names. Skipped when the bed's Hub isn't connected.
export const issue = 249;
export const clauses = [
  "with Hub connected, an agent's Hub calls go out with that agent's bound token, and the server agent's with the install token",
  "removing the agent revokes its token",
  "an agent approval made with the bound token is recorded on Hub as verified",
];
export const timeoutMs = 120000;
const ID = "gate-249-bound";
const SERVER = "server";

async function rows(ctx) {
  const r = await ctx.api("/api/sessions").catch(() => ({}));
  return Array.isArray(r?.sessions) ? r.sessions : [];
}
const rowOf = async (ctx, id) => (await rows(ctx)).find((x) => x.agent === id);
/** Whether the server's store holds a token file for `id` (null: can't tell). */
async function stored(ctx, id) {
  const names = await ctx.listBed("hub/agents");
  return Array.isArray(names) ? names.includes(`${id}.json`) : null;
}

export async function setup(ctx) {
  const hub = await ctx.api("/api/hub").catch(() => ({}));
  const s = { connected: hub?.connected === true };
  if (!s.connected) return s;
  const a = ctx.agent(ID);
  s.start = a.start("tester")?.code ?? null;
  s.runMs = await a.running(20000);
  await a.sessionStart?.();
  return s;
}

export async function run(ctx, s) {
  if (!s.connected) return s;
  const r = { ...s };
  const a = ctx.agent(ID);
  // A turn end: the Stop hook's inbox check goes to Hub through Den.
  await a.print?.("Done for now.");
  await a.stop();
  r.boundMs = await ctx.until(
    async () => (await rowOf(ctx, ID))?.hubBound === true,
    20000,
  );
  r.row = { hubBound: (await rowOf(ctx, ID))?.hubBound ?? null };
  const srv = await rowOf(ctx, SERVER);
  r.server = srv ? { listed: true, hubBound: srv.hubBound ?? null } : null;
  r.storedBefore = await stored(ctx, ID);

  a.exit();
  await ctx.until(() => a.state() !== "running", 10000);
  r.remove = a.remove()?.code ?? null;
  r.goneMs = await ctx.until(
    async () => !(await rowOf(ctx, ID)) && (await stored(ctx, ID)) === false,
    15000,
  );
  r.storedAfter = await stored(ctx, ID);
  return r;
}

export function expect(r) {
  if (!r.connected)
    return clauses.map((clause) => ({ clause, ok: null, skip: "needs-hub" }));
  return [
    {
      clause: clauses[0],
      ok:
        r.boundMs !== null &&
        r.row.hubBound === true &&
        r.storedBefore !== false &&
        // The server agent keeps the install's token: never "bound".
        (r.server === null || r.server.hubBound !== true),
      detail: `start ${r.start}, running after ${r.runMs} ms; row bound after ${r.boundMs} ms (${r.row.hubBound}); token in the server's store: ${r.storedBefore}; server agent row: ${JSON.stringify(r.server)}`,
    },
    {
      clause: clauses[1],
      ok:
        r.storedBefore === true && r.goneMs !== null && r.storedAfter === false,
      detail: `remove ${r.remove}; row and stored token gone after ${r.goneMs} ms (stored after: ${r.storedAfter}). Hub's side of the revoke is Hub's to show.`,
    },
    {
      clause: clauses[2],
      ok: null,
      skip: "needs-hub-approval-record",
      detail:
        "a stub agent makes no approval, and only Hub's record says verified; the unit test covers it with a fake Hub",
    },
  ];
}

export async function teardown(ctx) {
  const a = ctx.agent(ID);
  if (a.state()) a.remove();
}
