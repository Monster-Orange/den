// Live check for PR 573: methods other than GET, HEAD, POST, PUT, PATCH and
// DELETE answer 405 before any route, and the manifest check by path reads
// only inside a repo. Nothing here runs a command: every odd-method call is
// refused before a route, and validate only reads.
export const issue = 573;
export const clauses = [
  "OPTIONS and PROPFIND on the command routes answer 405, with no CORS header and no stream",
  "manifest validate by path refuses a file outside the repos, and quotes none of it",
  "manifest validate by path works inside a repo with the person's token",
];
export const timeoutMs = 90000;

const RUNNERS = [
  "/api/service/exec?repo=gate-573-none&service=gate-573-none&cmd=up&env=local",
  "/api/workspace/exec?ws=gate-573-none&cmd=up&env=local",
  "/api/workspace/sync?ws=gate-573-none",
  "/api/aws/login?env=local",
  "/api/run?pillar=smoke&env=local",
  "/api/service/logs?repo=gate-573-none&service=gate-573-none",
  "/api/service/taillog?repo=gate-573-none&service=gate-573-none",
  "/api/service/history?repo=gate-573-none&service=gate-573-none",
  "/api/logs/search?q=gate573&targets=gate-573-none/gate-573-none",
];
const OUTSIDE = ["/etc/hosts", "/gate-573-nothing-here.txt"];

const headerOf = (r, name) =>
  String(r.headers?.[name] ?? r.headers?.get?.(name) ?? "");
const headerNames = (r) =>
  r.headers?.keys ? [...r.headers.keys()] : Object.keys(r.headers ?? {});

/** Every absolute `path` value in a JSON tree. */
function paths(v, out = []) {
  if (Array.isArray(v)) for (const x of v) paths(x, out);
  else if (v && typeof v === "object")
    for (const [k, x] of Object.entries(v)) {
      if (k === "path" && typeof x === "string" && x.startsWith("/"))
        out.push(x);
      else paths(x, out);
    }
  return out;
}

const validate = (ctx, p) =>
  ctx.fetch(`/api/manifest/validate?path=${encodeURIComponent(p)}`);

export async function setup() {
  return {};
}

export async function run(ctx) {
  const odd = [];
  for (const route of RUNNERS)
    for (const method of ["OPTIONS", "PROPFIND"]) {
      const r = await ctx.fetch(route, { method });
      odd.push({
        route: route.split("?")[0],
        method,
        status: r.status,
        stream: /event-stream/.test(headerOf(r, "content-type")),
        cors: headerNames(r).some((k) =>
          k.toLowerCase().startsWith("access-control-"),
        ),
      });
    }
  const outside = [];
  for (const p of OUTSIDE) {
    const r = await validate(ctx, p);
    const body = String(r.body ?? "");
    outside.push({
      p,
      status: r.status,
      quoted: /127\.0\.0\.1|::1/.test(body),
    });
  }
  let inside = null;
  const listed = [
    ...new Set(paths(await ctx.api("/api/workspaces").catch(() => null))),
  ];
  for (const p of listed.slice(0, 5)) {
    const r = await validate(ctx, p);
    if (r.status === 200) {
      inside = { status: 200 };
      break;
    }
    inside = { status: r.status };
  }
  ctx.log?.(
    `odd: ${JSON.stringify(odd)}; outside: ${JSON.stringify(outside)}; inside: ${JSON.stringify(inside)} (${listed.length} repo paths)`,
  );
  return { odd, outside, inside, repos: listed.length };
}

export function expect(r) {
  const odd = r?.odd ?? [];
  const badOdd = odd
    .filter((x) => x.status !== 405 || x.stream || x.cors)
    .map(
      (x) =>
        `${x.method} ${x.route} → ${x.status}${x.stream ? " stream" : ""}${x.cors ? " cors" : ""}`,
    );
  const out = r?.outside ?? [];
  const badOut = out
    .filter((x) => x.status !== 403 || x.quoted)
    .map((x) => `${x.p} → ${x.status}${x.quoted ? " quoted" : ""}`);
  return [
    {
      clause: clauses[0],
      ok: odd.length === RUNNERS.length * 2 && badOdd.length === 0,
      evidence: ["573-log.txt"],
      ...(badOdd.length ? { note: badOdd.join("; ") } : {}),
    },
    {
      clause: clauses[1],
      ok: out.length === OUTSIDE.length && badOut.length === 0,
      ...(badOut.length ? { note: badOut.join("; ") } : {}),
    },
    !r?.repos
      ? { clause: clauses[2], ok: null, skip: "needs-repo" }
      : {
          clause: clauses[2],
          ok: r.inside?.status === 200,
          ...(r.inside?.status === 200
            ? {}
            : { note: `validate inside → ${r.inside?.status}` }),
        },
  ];
}
