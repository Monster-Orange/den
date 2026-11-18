/* eslint-env browser */
// Live check for #455: Den prints only an address it has just proven reaches this Den; when
// another server holds the port, Den names it and offers the two ways out (mock v3).
// Read only: it never binds a port, never changes a setting, and never presses Check again.
export const issue = 455;
export const clauses = [
  "Den never prints or links an address before checking it reaches this Den (an identity challenge, not a connect)",
  "the edge port check covers IPv4, IPv6 and the wildcard, on every up",
  "Den picks a working way in itself, with no port question",
  "doctor says whether the address is this Den, and names a busy port's owner and the options",
  "the banner shows once per browser and address, and Edge shows the owner and the two choices",
  "every new string has en/es/ja text",
  "when the edge can't start, every place uses the address that works, and says why once",
  "the route for nginx, Caddy and Traefik is ready to paste (doctor and Edge)",
];
export const matrix = { browsers: ["chromium", "webkit"], widths: [1440, 390] };
// Quiet, a cell took ~9 s (the /edge page 0.8–2.5 s on the remote browser, the 1.5 s settle, the CLI calls ~4 s): 4× that is under the 300 s floor.
export const timeoutMs = 300000;

const hex = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");

export async function setup(ctx) {
  const s = {};
  // The identity route: a challenge gets a 64-hex answer; a non-challenge is refused.
  const c = hex();
  const good = await ctx.fetch(`/api/den-identity?c=${c}`);
  const again = await ctx.fetch(`/api/den-identity?c=${c}`);
  const bad = await ctx.fetch("/api/den-identity?c=nope");
  const body = (r) => {
    try {
      return typeof r.body === "string" ? JSON.parse(r.body) : r.body;
    } catch {
      return null;
    }
  };
  s.identity = {
    status: good.status,
    den: body(good)?.den ?? null,
    answerShape: /^[0-9a-f]{64}$/.test(body(good)?.answer ?? ""),
    stable: body(good)?.answer === body(again)?.answer,
    badStatus: bad.status,
  };
  s.address = await ctx.api("/api/edge/address");
  const d = ctx.cli(["doctor"]);
  s.doctor = {
    code: d.code,
    lines: (d.out || "")
      .split("\n")
      .filter((l) =>
        /checked just now|is held by|in use by something|no address was checked|Options: free port|edge route --for/.test(
          l,
        ),
      )
      .map((l) => l.trim()),
  };
  s.routes = {};
  for (const kind of ["nginx", "caddy", "traefik"]) {
    const r = ctx.cli(["edge", "route", "--for", kind]);
    s.routes[kind] = {
      code: r.code,
      out: r.out || "",
      err: (r.err || "").trim(),
    };
  }
  return s;
}

export async function run(ctx, state) {
  const tag = `${ctx.browser}-${ctx.width}`;
  await ctx.goto(ctx.page, "/edge");
  await ctx.page
    .waitForSelector("#edge-body:not([aria-busy])", { timeout: 15000 })
    .catch(() => {});
  await ctx.sleep(1500);
  const r = await ctx.page.evaluate(() => ({
    card: !!document.querySelector("[data-address-card]"),
    banner: !!document.querySelector('[data-banner="den-address"]'),
    hScroll:
      document.documentElement.scrollWidth >
      document.documentElement.clientWidth + 1,
  }));
  await ctx.shot(`edge-${tag}`);
  // The harness calls expect(result) alone, so each cell carries what
  // setup saw (identity, address, doctor, routes).
  return { ...r, setup: state };
}

export function expect(cells) {
  const s = cells.find((c) => c.result?.setup)?.result.setup ?? {};
  const st = s.address ?? {};
  const held = st.wantedAnswer && st.wantedAnswer !== "den";
  const d = (f) =>
    cells
      .map(({ cell, result }) => `${cell.browser}@${cell.width}: ${f(result)}`)
      .join("; ");
  const shots = cells.map(
    ({ cell }) => `edge-${cell.browser}-${cell.width}.png`,
  );
  const routeOk = (k, re) =>
    s.routes?.[k]?.code === 0 && re.test(s.routes[k].out);
  return [
    {
      clause: clauses[0],
      ok:
        s.identity?.status === 200 &&
        s.identity.den === "identity" &&
        s.identity.answerShape &&
        s.identity.stable &&
        s.identity.badStatus === 400 &&
        !!st.address &&
        (st.address === st.wanted
          ? st.wantedAnswer === "den"
          : st.directOk === true),
      detail: `identity ${JSON.stringify(s.identity)}; printed ${st.address} (wanted ${st.wanted}: ${st.wantedAnswer}; direct proven ${st.directOk})`,
    },
    {
      clause: clauses[1],
      ok: null,
      skip: "needs-held-port",
      detail:
        "proven red-first in tests/unit/edge/address-455.test.ts (IPv6-only, v6 wildcard, one interface); the bed's port can't be held without touching it",
    },
    {
      clause: clauses[2],
      ok: !!st.address && (st.wantedAnswer === "den" || st.directOk === true),
      detail: `address ${st.address}, chosen without a question`,
    },
    {
      clause: clauses[3],
      ok:
        s.doctor?.lines?.length > 0 &&
        (held
          ? s.doctor.lines.some((l) => /Options: free port/.test(l))
          : s.doctor.lines.some((l) => /checked just now: it is this/.test(l))),
      detail: s.doctor?.lines?.join(" | ") || "no address line in doctor",
    },
    held
      ? {
          clause: clauses[4],
          ok: cells.every(({ result }) => result.card && !result.hScroll),
          detail: d(
            (r) =>
              `card ${r.card}, banner ${r.banner}, side scroll ${r.hScroll}`,
          ),
          evidence: shots,
        }
      : {
          clause: clauses[4],
          ok: null,
          skip: "needs-held-port",
          detail:
            d(
              (r) =>
                `no card ${!r.card}, no banner ${!r.banner}, side scroll ${r.hScroll}`,
            ) + " (the address works here, so both rightly say nothing)",
          evidence: shots,
        },
    {
      clause: clauses[5],
      ok: null,
      skip: "needs-language-switch",
      detail:
        "es/ja parity is held by tests (i18n.test.ts, address-455-parts.test.ts)",
    },
    held
      ? {
          clause: clauses[6],
          ok: st.directOk === true && st.address !== st.wanted,
          detail: `wanted ${st.wanted} answers as ${st.answeredAs ?? "something else"}; Den gives ${st.address}`,
        }
      : {
          clause: clauses[6],
          ok: null,
          skip: "needs-held-port",
          detail: `the address works: ${st.wanted}`,
        },
    {
      clause: clauses[7],
      ok:
        routeOk("nginx", /server_name .+;[\s\S]*proxy_pass http:\/\//) &&
        routeOk("caddy", /reverse_proxy /) &&
        routeOk("traefik", /rule: "Host\(`/),
      detail: Object.entries(s.routes ?? {})
        .map(
          ([k, r]) => `${k}: exit ${r.code}, ${r.out.split("\n").length} lines`,
        )
        .join("; "),
    },
  ];
}
