// Live check for issue 666: Den never takes a loopback name (localhost,
// *.localhost, 127.x, ::1) as its address, doctor fails one, and a browser
// on the install's edge alias while the address is wrong is offered "Make
// <alias> Den's address" after the owner's sign-in, never locked out.
//
// Clause 1 only asks for writes that are refused before anything is saved
// (Settings' Check and save, the alias offer's adopt, and `web url`), and
// reads the address before and after: it never changes the bed. Even if
// the rule were gone, a loopback name never answers the check as this Den,
// so nothing would be saved (a 422 there is a FAIL: the wrong refusal).
// Clause 2 reads doctor, and runs only when the bed's own address is a
// loopback name (the paths above refuse to make one). Clause 3 needs an
// alias of the bed that isn't loopback, reached by the browser, while the
// address is wrong; it only looks at the offer and never presses it (that
// is the owner's act, and it would change the bed's address for good).
// The loopback /signin redirect is issue 601's, not asserted here.
export const issue = 666;
export const clauses = [
  "a settings change or write to a loopback address (localhost, *.localhost, 127.x, ::1) is refused, and the address stays as it was",
  "doctor fails a loopback address, with the fix",
  "a browser on the edge alias while the address is wrong is offered \"Make <alias> Den's address\" after the owner's sign-in, not locked out",
];
export const matrix = { browsers: ["chromium"], widths: [1280] };
export const timeoutMs = 180000;

const LOOPS = [
  "https://gate666.localhost",
  "http://localhost:7999",
  "https://127.0.0.2",
  "https://[::1]:7443",
];
const SAYS = /names this machine only/;

/** doctor --json's address check, or null. */
function addressRow(out) {
  const at = String(out ?? "").indexOf("{");
  if (at < 0) return null;
  try {
    const j = JSON.parse(String(out).slice(at));
    return (j.checks ?? []).find((c) => c?.id === "address") ?? null;
  } catch {
    return null;
  }
}

const where = (w) =>
  w ? { url: w.url ?? null, confirmed: !!w.confirmed, loopback: !!w.loopback } : null;

export async function setup() {
  return {};
}

export async function run(ctx) {
  const before = where(await ctx.api("/api/web-url").catch(() => null));

  // Clause 1: each form, through Settings' Check and save and the adopt
  // route; one through the CLI.
  const tries = [];
  for (const url of LOOPS) {
    for (const path of ["/api/web-url", "/api/web-url/adopt"]) {
      const r = await ctx
        .fetch(path, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ url }),
        })
        .catch((e) => ({ status: 0, body: { error: String(e?.message ?? e) } }));
      tries.push({
        path,
        url,
        status: r.status,
        code: r.body?.code ?? null,
        error: String(r.body?.error ?? "").slice(0, 120),
      });
    }
  }
  const c = await ctx.cli(["web", "url", LOOPS[0], "--json"]);
  const cli = {
    code: c.code,
    said: String(c.out || c.err || "").slice(0, 160),
  };
  const after = where(await ctx.api("/api/web-url").catch(() => null));

  // Clause 2: doctor's address row.
  const d = await ctx.cli(["doctor", "--json"]);
  const row = addressRow(d.out);

  // Clause 3: what this browser is offered, on the address it is on.
  await ctx.goto(ctx.page, "/settings?q=web.url");
  const origin = new URL(ctx.page.url()).origin;
  const here = await ctx.page
    .evaluate(async () => {
      const r = await fetch("/api/web-url", { credentials: "same-origin" });
      return r.ok ? r.json() : { status: r.status };
    })
    .catch(() => null);
  let offer = null;
  if (here?.offer && here.offer === origin) {
    const btn = ctx.page.locator(`[data-addr-adopt="${here.offer}"]`);
    const shown = await btn
      .waitFor({ timeout: 15000 })
      .then(() => true)
      .catch(() => false);
    offer = {
      alias: here.offer,
      shown,
      label: shown ? ((await btn.textContent()) ?? "").trim() : "",
    };
    await ctx.shot("666-offer");
    // Signed out on the alias: the sign-in page leads with the offer.
    const out = await ctx.signedOut(ctx.browser, ctx.width);
    try {
      await ctx.goto(out.page, "/");
      offer.signinOffer = !!(await ctx.until(
        async () => (await out.page.locator("#den-signin-offer").count()) > 0,
        15000,
      ));
      offer.signinTitle = offer.signinOffer
        ? ((await out.page.locator("#den-offer-title").textContent()) ?? "").trim()
        : "";
      await ctx.shotOf(out.page, "666-signin-offer");
    } finally {
      await out.page.context().close().catch(() => {});
    }
  }

  const seen = {
    before,
    after,
    tries,
    cli,
    row: row ? { status: row.status, detail: String(row.detail ?? "").slice(0, 200) } : null,
    origin,
    here: here
      ? { url: here.url ?? null, loopback: !!here.loopback, offer: here.offer ?? null }
      : null,
    offer,
  };
  ctx.log?.(`666: ${JSON.stringify(seen)}`);
  return seen;
}

export function expect(cells) {
  const r = (Array.isArray(cells) ? cells[0]?.result : cells) ?? {};
  const tries = r.tries ?? [];
  const agentOnly = tries.length > 0 && tries.every((t) => t.status === 403);
  const refused = (t) =>
    t.path === "/api/web-url"
      ? t.status === 400 && SAYS.test(t.error)
      : t.status === 400 && t.code === "not_an_alias";
  const same =
    JSON.stringify(r.before ?? null) === JSON.stringify(r.after ?? null);
  const cliOk = r.cli?.code === 2 && SAYS.test(r.cli?.said ?? "");
  const tryLine = tries
    .map((t) => `${t.path} ${t.url} → ${t.status}${t.code ? " " + t.code : ""}`)
    .join("; ");
  const rows = [
    agentOnly
      ? {
          clause: clauses[0],
          ok: null,
          skip: "needs-person-session",
          detail: "every write was refused as an agent's (403), so the loopback rule wasn't reached",
        }
      : {
          clause: clauses[0],
          ok: tries.length === LOOPS.length * 2 && tries.every(refused) && cliOk && same,
          detail: `${tryLine}; web url ${LOOPS[0]} → exit ${r.cli?.code}: ${r.cli?.said}; address ${JSON.stringify(r.before)} → ${JSON.stringify(r.after)}`,
        },
  ];
  rows.push(
    !r.before?.loopback
      ? {
          clause: clauses[1],
          ok: null,
          skip: "needs-loopback-address",
          detail: `the bed's address is ${r.before?.url ?? "unset"}, not a loopback name; a check can't make one (every path refuses it)`,
        }
      : {
          clause: clauses[1],
          ok:
            r.row?.status === "fail" &&
            SAYS.test(r.row.detail) &&
            /web url |Settings/.test(r.row.detail),
          detail: r.row
            ? `${r.row.status}: ${r.row.detail}`
            : "no address row in doctor --json",
        },
  );
  rows.push(
    !r.offer
      ? {
          clause: clauses[2],
          ok: null,
          skip: "needs-wrong-address-bed",
          detail: `the browser is on ${r.origin}; the server offers ${r.here?.offer ?? "no alias"} (address ${r.here?.url ?? "unset"}${r.here?.loopback ? ", loopback" : ""}). The bed needs an edge alias that isn't loopback (a split-DNS name with the edge's https and proof, on one of its edge routes), the browser on it, and the address wrong (loopback, unconfirmed or not answering)`,
        }
      : {
          clause: clauses[2],
          ok: !!(r.offer.shown && r.offer.label.includes(new URL(r.offer.alias).host) && r.offer.signinOffer),
          detail: `on ${r.offer.alias}: Settings shows "${r.offer.label}" (${r.offer.shown ? "shown" : "missing"}); signed out, the sign-in page ${r.offer.signinOffer ? `leads with "${r.offer.signinTitle}"` : "has no offer"}`,
          evidence: ["666-offer", "666-signin-offer"],
        },
  );
  return rows;
}
