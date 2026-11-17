// Live check for #369: a "needs your permission" bell row kept across a server restart leaves the bell
// when its agent is stopped or shows no dialog, and stays (a live wait again) when the agent still waits.
// Three bed stub agents, gate-369-*, removed in teardown. The bed's own web server is taken down and
// brought back once (the harness restarts it too); teardown brings it up if it isn't answering.
export const issue = 369;
export const clauses = [
  "a row whose agent is stopped is withdrawn after a server restart",
  "a row whose agent shows no waiting dialog is withdrawn after a server restart",
  "a row whose agent really is still waiting is kept and adopted as a live wait",
];
export const timeoutMs = 180000;
const STOPPED = "gate-369-stopped";
const IDLE = "gate-369-idle";
const ASKS = "gate-369-asks";
const IDS = [STOPPED, IDLE, ASKS];
// Claude Code's permission dialog as its terminal draws it, in the stub's /print escapes.
const DIALOG =
  "\\u001b[2J\\u001b[HBash command\\r\\n  npm test\\r\\n  Run the tests\\r\\n\\r\\nDo you want to proceed?\\r\\n❯ 1. Yes\\r\\n  2. Yes, and don't ask again for npm test commands\\r\\n  3. No, and tell Claude what to do differently (esc)\\r\\n";
const PROMPT = "\\u001b[2J\\u001b[H> ";

async function bellFor(ctx, id) {
  const n = await ctx.api("/api/notifications").catch(() => ({}));
  const rows = (n.groups || [])
    .flatMap((g) => g.subjects || [])
    .filter((s) => s.subject === `agent:${id}`)
    .flatMap((s) => s.items || [])
    .filter((i) => i.kind === "waiting")
    .map((i) => i.text);
  return { live: (n.waiting || []).some((w) => w.agent === id), rows };
}
const answering = async (ctx) => {
  try {
    return Array.isArray((await ctx.api("/api/notifications")).groups);
  } catch {
    return false;
  }
};

export async function setup(ctx) {
  const s = { start: {} };
  for (const id of IDS) {
    const a = ctx.agent(id);
    s.start[id] = a.start("tester").code;
    await a.running(20000);
  }
  await ctx.sleep(2500);
  for (const id of IDS) {
    const a = ctx.agent(id);
    a.print(DIALOG);
    a.permissionRequest("Bash", { command: "npm test" });
  }
  s.raisedMs = await ctx.until(async () => {
    for (const id of IDS)
      if (!(await bellFor(ctx, id)).rows.length) return false;
    return true;
  }, 15000);
  return s;
}

export async function run(ctx, s) {
  const r = { ...s };
  // The idle agent leaves its dialog (back at its prompt) where only its screen says so.
  ctx.agent(IDLE).print(PROMPT);
  await ctx.sleep(1000);
  r.down = ctx.cli(["web", "down", "--json"]).code;
  r.downMs = await ctx.until(async () => !(await answering(ctx)), 20000);
  // Stopped while no server was there to see it.
  r.stop = ctx.agent(STOPPED).stop().code;
  r.up = ctx.cli(["web", "up", "--no-open"]).code;
  r.upMs = await ctx.until(() => answering(ctx), 60000);
  // At start, or on the attention check after it.
  r.settleMs = await ctx.until(async () => {
    const [a, b] = [await bellFor(ctx, STOPPED), await bellFor(ctx, IDLE)];
    return a.rows.length === 0 && b.rows.length === 0;
  }, 20000);
  await ctx.sleep(3000);
  r.after = {};
  for (const id of IDS) r.after[id] = await bellFor(ctx, id);
  return r;
}

export function expect(r) {
  const ready = r.raisedMs !== null && r.upMs !== null;
  const ran = `rows raised ${r.raisedMs} ms; web down ${r.down}, up ${r.up} (${r.upMs} ms)`;
  const one = (id) =>
    `${id}: rows ${JSON.stringify(r.after?.[id]?.rows ?? null)}, live wait ${r.after?.[id]?.live ?? null}`;
  return [
    {
      clause: clauses[0],
      ok:
        ready &&
        r.stop === 0 &&
        r.after[STOPPED].rows.length === 0 &&
        !r.after[STOPPED].live,
      detail: `${ran}; stopped while down: ${r.stop}; ${one(STOPPED)}`,
    },
    {
      clause: clauses[1],
      ok: ready && r.after[IDLE].rows.length === 0 && !r.after[IDLE].live,
      detail: `${ran}; ${one(IDLE)}`,
    },
    {
      clause: clauses[2],
      ok: ready && r.after[ASKS].rows.length > 0 && r.after[ASKS].live,
      detail: `${ran}; ${one(ASKS)}`,
    },
  ];
}

export async function teardown(ctx) {
  if (!(await answering(ctx))) {
    ctx.cli(["web", "up", "--no-open"]);
    await ctx.until(() => answering(ctx), 60000);
  }
  for (const id of IDS) if (ctx.agent(id).state()) ctx.agent(id).remove();
}
