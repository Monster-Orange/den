// Live check for PR 536: the live log route takes only catalog-shaped repo
// and service names, as the log history and search routes do. Read only:
// every name here is refused before anything resolves or runs.
export const issue = 536;
export const clauses = [
  "the live log route answers 400 to a repo or service name that isn't a catalog name",
  "that answer is plain JSON at once, never a log stream",
  "the log history route answers the same names the same way",
];
export const timeoutMs = 60000;

const NAMES = ["../outside", "a b", "a;b", "a|b", ".hidden", 'a"b'];

export async function setup() {
  return {};
}

async function ask(ctx, route, repo, service) {
  const q = new URLSearchParams({ repo, service }).toString();
  const r = await ctx.fetch(`${route}?${q}`);
  const type = String(
    r.headers?.["content-type"] ?? r.headers?.get?.("content-type") ?? "",
  );
  return { status: r.status, stream: /event-stream/.test(type) };
}

export async function run(ctx) {
  const out = { tail: [], history: [] };
  for (const n of NAMES) {
    out.tail.push({
      n,
      as: "service",
      ...(await ask(ctx, "/api/service/taillog", "nothing-here", n)),
    });
    out.tail.push({
      n,
      as: "repo",
      ...(await ask(ctx, "/api/service/taillog", n, "svc")),
    });
    out.history.push({
      n,
      ...(await ask(ctx, "/api/service/history", n, "svc")),
    });
  }
  ctx.log?.(
    `taillog: ${JSON.stringify(out.tail)}; history: ${JSON.stringify(out.history)}`,
  );
  return out;
}

export function expect(r) {
  const tail = r?.tail ?? [];
  const hist = r?.history ?? [];
  const bad = (xs) =>
    xs
      .filter((x) => x.status !== 400)
      .map((x) => `${x.as ?? "repo"} ${JSON.stringify(x.n)} → ${x.status}`);
  const streamed = tail.filter((x) => x.stream);
  // History is behind the local-dev switch: 403 there means it's off.
  const histOff = hist.length > 0 && hist.every((x) => x.status === 403);
  return [
    {
      clause: clauses[0],
      ok: tail.length === NAMES.length * 2 && bad(tail).length === 0,
      evidence: ["536-log.txt"],
      ...(bad(tail).length ? { note: bad(tail).join("; ") } : {}),
    },
    {
      clause: clauses[1],
      ok: tail.length > 0 && streamed.length === 0,
      ...(streamed.length ? { note: `${streamed.length} streamed` } : {}),
    },
    histOff
      ? { clause: clauses[2], ok: null, skip: "needs-local-dev" }
      : {
          clause: clauses[2],
          ok: hist.length === NAMES.length && bad(hist).length === 0,
          ...(bad(hist).length ? { note: bad(hist).join("; ") } : {}),
        },
  ];
}
