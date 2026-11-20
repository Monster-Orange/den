// gate/726.mjs: changing a Den's Hub is clean (issue 726).
//
// The bed has one Hub, and a real change would revoke the bed's own token
// (getting a new one is the person's Connect, in Hub's sign-in page). So
// the change itself is not run here: the four clauses of the issue skip
// (needs-second-hub) and are proven by the jest suites named in the PR
// (hub-binding, hub-change, hub-connect, hub-address, doctor-hub-previous).
// What the bed does prove, without changing its settings for good:
//   - Den's Hub state is bound to the Hub it uses (state:hub/bound.json:
//     its origin), which every clause rests on;
//   - doctor has the "state from an earlier Hub" row and the revoke row;
//   - through the API, saving the same address (a trailing slash) is not a
//     change: no revoke, still connected; and a bad address is refused
//     before anything is revoked.
export const issue = 726;
export const clauses = [
  "after a Hub change, no project is linked to an id from the old Hub, and the bell offers the picks",
  "a comment posted on the new Hub after the change is typed once, and no comment from the old Hub is typed or reported to the new one",
  "changing the address through the API revokes the old token (or doctor names it as not revoked)",
  "no bell item from the old Hub remains after the change",
  "this install's Hub state is bound to the Hub it uses",
  "doctor has a row for state from an earlier Hub, and one for tokens not revoked",
  "through the API, the same address is not a change and a bad one is refused, and the token still works",
];
export const timeoutMs = 120000;

const parse = (b) => {
  if (b && typeof b === "object") return b;
  try {
    return JSON.parse(b);
  } catch {
    return null;
  }
};

const origin = (u) => {
  try {
    return new URL(u).origin;
  } catch {
    return "";
  }
};

async function hubState(ctx) {
  const h = await ctx.api("/api/hub?rail=1").catch(() => null);
  return h?.state ?? null;
}

const save = (ctx, url) =>
  ctx.fetch("/api/settings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ hub_url: url }),
  });

export async function setup(ctx) {
  if (!ctx.hub?.url) return { skip: "needs-hub" };
  const s = await ctx.api("/api/settings").catch(() => null);
  return { hubUrl: s?.hub_url ?? null };
}

export async function run(ctx, s) {
  if (s.skip) return s;
  const bound = parse(ctx.readBed("state:hub/bound.json"));
  const d = parse((await ctx.cli(["doctor", "--json"])).out);
  const checks = Array.isArray(d?.checks) ? d.checks : [];
  const row = (id) => {
    const c = checks.find((x) => x?.id === id);
    return c ? { status: c.status, detail: String(c.detail ?? "") } : null;
  };
  const before = await hubState(ctx);
  let same = null;
  let bad = null;
  if (s.hubUrl) {
    same = (await save(ctx, `${s.hubUrl}/`)).status;
    bad = (await save(ctx, "http://hub-726.invalid")).status;
  }
  const after = await hubState(ctx);
  return {
    hub: origin(ctx.hub.url),
    hubUrl: s.hubUrl ? origin(s.hubUrl) : null,
    bound: bound ? { origin: bound.origin, company: !!bound.company } : null,
    previous: row("hub:previous"),
    unrevoked: row("hub:unrevoked"),
    before,
    after,
    same,
    bad,
  };
}

export async function teardown(ctx, s) {
  // Put the address back exactly as it was (a no-op when nothing moved).
  if (s?.hubUrl) await save(ctx, s.hubUrl).catch(() => undefined);
}

export function expect(cells) {
  const r = cells[0]?.result ?? {};
  const live = [0, 1, 2, 3].map((i) => ({
    clause: clauses[i],
    ok: null,
    skip: r.skip ?? "needs-second-hub",
  }));
  if (r.skip)
    return [
      ...live,
      ...[4, 5, 6].map((i) => ({ clause: clauses[i], ok: null, skip: r.skip })),
    ];
  const want = r.hubUrl ?? r.hub;
  return [
    ...live,
    {
      clause: clauses[4],
      ok: !!r.bound && r.bound.origin === want,
      detail: `bound to ${r.bound?.origin ?? "nothing"}${r.bound?.company ? " with its company" : ""}; the bed's Hub is ${want}`,
    },
    {
      clause: clauses[5],
      ok: !!r.previous && !!r.unrevoked && r.previous.status !== "fail",
      detail: `hub:previous ${r.previous ? `${r.previous.status}: ${r.previous.detail}` : "missing"}; hub:unrevoked ${r.unrevoked ? `${r.unrevoked.status}: ${r.unrevoked.detail}` : "missing"}`,
    },
    r.hubUrl
      ? {
          clause: clauses[6],
          ok: r.same === 200 && r.bad === 400 && r.after === r.before,
          detail: `same address with a slash: ${r.same}; a bad address: ${r.bad}; Hub ${r.before} before, ${r.after} after`,
        }
      : { clause: clauses[6], ok: null, skip: "needs-hub-url" },
  ];
}
