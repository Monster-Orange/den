// Live check for #330 (a): a Traefik v2 edge with the access log on starts with no request-id (tracing) flags.
// The bed's own edge only; teardown and the harness put its image back.
export const issue = 330;
export const clauses = [
  "edge up says the access log runs without request ids on traefik:v2.11",
  "the v2.11 edge starts with no --tracing flags and stays up",
  "the page answers through the v2.11 edge",
];
export const matrix = { browsers: ["chromium", "webkit"], widths: [1280] };
export const timeoutMs = 120000;

export async function setup(ctx) {
  const up = ctx.edge.swap({ image: "traefik:v2.11", accessLog: true });
  await ctx.sleep(30000);
  const i = ctx.edge.inspect();
  return {
    up: up.all,
    image: i.image,
    status: i.status,
    restarts: i.restarts,
    tracing: i.args.filter((a) => /tracing/.test(a)).length,
    access: i.args.filter((a) => /accesslog/.test(a)).length,
  };
}

export async function run(ctx, s) {
  const resp = await ctx.goto(ctx.page, "/agents");
  await ctx.shot(`v2-agents-${ctx.browser}`);
  return { ...s, http: resp?.status() ?? null };
}

export function expect(cells) {
  const r = cells[0].result;
  return [
    {
      clause: clauses[0],
      ok: /Access log on without request ids: traefik:v2\.11 is older than Traefik v3\./.test(
        r.up,
      ),
      detail: (
        r.up.split("\n").find((l) => /Access log/.test(l)) || "no notice"
      ).trim(),
    },
    {
      clause: clauses[1],
      ok:
        r.image === "traefik:v2.11" &&
        r.status === "running" &&
        r.restarts === 0 &&
        r.tracing === 0 &&
        r.access > 0,
      detail: `${r.image} ${r.status}, restarts ${r.restarts} after 30 s, tracing args ${r.tracing}, accesslog args ${r.access}`,
    },
    {
      clause: clauses[2],
      ok: cells.every((c) => c.result.http === 200),
      detail: cells.map((c) => `${c.cell.browser} ${c.result.http}`).join(", "),
      evidence: cells.map((c) => `v2-agents-${c.cell.browser}.png`),
    },
  ];
}

export async function teardown(ctx) {
  ctx.edge.restore();
}
