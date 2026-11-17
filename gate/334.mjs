// Live check for #334: an app server's key reaches only its one agent's embed routes. Making or revoking a
// key is a person's Allow, so this check uses a made-up key in the real key's format: it must be refused
// on the state route (401) and on every other route (403), and nothing runs.
export const issue = 334;
export const clauses = [
  "a server key per project + agent, created by the person in Settings › Embedding (a held write with Allow)",
  "say with that key is delivered after the agent's turn, never typed mid-turn",
  "a per-agent state GET accepts that key, and nothing else",
  "a revoked key gets 401",
  "a key that is not one of the install's gets 401",
  "the key can't reach any other route",
];
export const timeoutMs = 60000;
const FAKE = `den_sk_${"0".repeat(16)}_${"gate334".padEnd(43, "x")}`;
const OTHER = [
  "/api/agents",
  "/api/notifications",
  "/api/settings",
  "/api/approvals",
];

// ctx.api answers with the reply's JSON (the bed's driver) or a Response (the contract's fetch).
async function call(ctx, p, init) {
  const r = await ctx.api(p, init);
  if (typeof r?.json === "function")
    return { status: r.status, body: await r.json().catch(() => ({})) };
  return { status: r?.status ?? null, body: r ?? {} };
}

export async function setup() {
  return {};
}

export async function run(ctx) {
  const h = { headers: { "X-Den-Embed-Key": FAKE } };
  const state = await call(
    ctx,
    "/api/embed/p/gate-334/agents/gate-334-none/state",
    h,
  );
  const other = [];
  for (const p of OTHER) {
    const r = await call(ctx, p, h);
    other.push({ p, status: r.status, code: r.body?.code ?? null });
  }
  const mint = await call(ctx, "/api/embed/keys", {
    method: "POST",
    headers: { ...h.headers, "content-type": "application/json" },
    body: JSON.stringify({
      project: "gate-334",
      agent: "gate-334-none",
      origin: "https://gate-334.invalid",
    }),
  });
  other.push({
    p: "POST /api/embed/keys",
    status: mint.status,
    code: mint.body?.code ?? null,
  });
  // The same read without the key still answers: the key is what was refused.
  const plain = await call(ctx, "/api/settings");
  return {
    state: { status: state.status, code: state.body?.code ?? null },
    other,
    plainOk: !plain.body?.code,
  };
}

export function expect(r) {
  return [
    {
      clause: clauses[0],
      ok: null,
      skip: "person",
      detail: "a key is made only on the person's own Allow",
    },
    {
      clause: clauses[1],
      ok: null,
      skip: "person",
      detail: "needs a real key, made on a person's Allow",
    },
    {
      clause: clauses[2],
      ok: null,
      skip: "person",
      detail:
        "the accepting half needs a real key; the refusing half is the rows below",
    },
    {
      clause: clauses[3],
      ok: null,
      skip: "person",
      detail: "revoking is the person's own Allow",
    },
    {
      clause: clauses[4],
      ok:
        r.state.code === "bad_key" &&
        (r.state.status === 401 || r.state.status === null),
      detail: `state with a made-up key: ${r.state.status ?? ""} ${r.state.code}`,
    },
    {
      clause: clauses[5],
      ok:
        r.other.every(
          (o) =>
            o.code === "embed_key_scope" &&
            (o.status === 403 || o.status === null),
        ) && r.plainOk,
      detail:
        r.other.map((o) => `${o.p} ${o.status ?? ""} ${o.code}`).join("; ") +
        `; /api/settings without the key ${r.plainOk ? "answers" : "refused"}`,
    },
  ];
}
