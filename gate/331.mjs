// Live check for #331: doctor warns when edge.image is a Traefik major below 3, or a tag Den can't read a
// version from, naming what's missing and the default image to move to.
// The bed's own edge only (ctx.edge.swap, as in 330); teardown and the harness put its image back.
import { doctorChecks } from "./lib/read-json.mjs";
export const issue = 331;
export const clauses = [
  "doctor is quiet about edge.image on Den's default Traefik v3",
  "doctor warns when edge.image is a Traefik major below 3, naming the missing request ids and the default image",
  "doctor warns when edge.image is a tag Den can't read a version from, naming the default image",
];
export const timeoutMs = 300000;
const DEFAULT = /Set edge\.image to traefik:v3\.\d+\.\d+, Den's default\./;

// Issue 840: doctor --json's strategy:tls check carries the edge.image
// line: a warning in its detail, the healthy line in its notes.
function imageView(d) {
  const c = doctorChecks(d).find((x) => x?.id === "strategy:tls");
  const said = [c?.detail ?? "", ...(c?.notes ?? [])].filter((t) =>
    /edge\.image/.test(t),
  );
  return { code: d.code, status: c?.status ?? null, lines: said };
}

export async function setup() {
  return {};
}

export async function run(ctx) {
  const r = {};
  r.base = imageView(ctx.cli(["doctor", "--json"]));
  ctx.edge.swap({ image: "traefik:v2.11" });
  r.v2 = imageView(ctx.cli(["doctor", "--json"]));
  ctx.edge.swap({ image: "traefik:latest" });
  r.latest = imageView(ctx.cli(["doctor", "--json"]));
  return r;
}

export function expect(r) {
  const v2 = r.v2.lines.join(" ");
  const latest = r.latest.lines.join(" ");
  return [
    {
      clause: clauses[0],
      ok: !r.base.lines.some((l) => /Set edge\.image to/.test(l)),
      detail: r.base.lines.join(" | ") || "no edge.image line (no warning)",
    },
    {
      clause: clauses[1],
      ok:
        /edge\.image traefik:v2\.11 is Traefik v2/.test(v2) &&
        /no request ids/.test(v2) &&
        DEFAULT.test(v2),
      detail: v2 || "no edge.image line",
    },
    {
      clause: clauses[2],
      ok:
        /edge\.image traefik:latest: Den can't tell which Traefik version it is/.test(
          latest,
        ) && DEFAULT.test(latest),
      detail: latest || "no edge.image line",
    },
  ];
}

export async function teardown(ctx) {
  ctx.edge.restore();
}
