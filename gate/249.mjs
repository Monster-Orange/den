import { allSessions } from "./lib/sessions.mjs";
export const issue = 249;
export const clauses = [
  "with Hub connected, an agent's Hub calls go out with that agent's bound token, and the server agent's with the install token",
  "removing the agent revokes its token",
  "an agent approval made with the bound token is recorded on Hub as verified",
];
export const timeoutMs = 180000;
const ID = "gate-249-bound";
const SERVER = "server";

async function rows(ctx) {
  const r = await allSessions((u) => ctx.api(u)).catch(() => ({}));
  return Array.isArray(r?.sessions) ? r.sessions : [];
}
const rowOf = async (ctx, id) => (await rows(ctx)).find((x) => x.agent === id);
async function stored(ctx, id) {
  const names = await ctx.listBed("state:hub/agents");
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
  await a.exit();
  r.boundMs = await ctx.until(
    async () =>
      (await rowOf(ctx, ID))?.hubBound === true &&
      (await stored(ctx, ID)) === true,
    45000,
  );
  r.row = { hubBound: (await rowOf(ctx, ID))?.hubBound ?? null };
  const srv = await rowOf(ctx, SERVER);
  r.server = srv ? { listed: true, hubBound: srv.hubBound ?? null } : null;
  r.storedBefore = await stored(ctx, ID);

  await a.stop();
  await ctx.until(() => a.state() !== "running", 20000);
  r.remove = a.remove()?.code ?? null;
  r.goneMs = await ctx.until(
    async () => !(await rowOf(ctx, ID)) && (await stored(ctx, ID)) === false,
    35000,
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
