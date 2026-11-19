// Live check for issue 601: once Den's own https address is proven, the
// sign-in session lives only there, as a host-only Secure cookie, and a
// loopback name gets none (its sign-in page sends the browser to the
// address). With no working https address, sign-in where the browser is
// still works: no lockout. It only reads: no write, no setting changed.
export const issue = 601;
export const clauses = [
  "a real browser signed in through the address holds a host-only Secure __Host- session cookie, and the session answers signed in",
  "once the address is proven, a loopback sign-in page sends the browser to the address (303) and sets no cookie",
  "with no working https address, the loopback sign-in page is served, not sent away: no lockout",
  "doctor's Sign-in row says where the sign-in lives",
];
export const matrix = { browsers: ["chromium"], widths: [1280] };
export const timeoutMs = 90000;

/** doctor --json's signin_host check, or null. */
function signinRow(out) {
  const at = String(out ?? "").indexOf("{");
  if (at < 0) return null;
  try {
    const j = JSON.parse(String(out).slice(at));
    return (j.checks ?? []).find((c) => c?.id === "signin_host") ?? null;
  } catch {
    return null;
  }
}

/** A loopback GET with nothing: its status, Location, and whether it set a cookie. */
async function loopback(port, path) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, {
      redirect: "manual",
    });
    return {
      status: r.status,
      location: r.headers.get("location") ?? "",
      cookie: /den_session/i.test(r.headers.get("set-cookie") ?? ""),
    };
  } catch (e) {
    return {
      status: 0,
      location: "",
      cookie: false,
      error: String(e?.message ?? e).slice(0, 80),
    };
  }
}

export async function setup() {
  return {};
}

export async function run(ctx) {
  const doc = await ctx.cli(["doctor", "--json"]);
  const row = signinRow(doc.out);
  const proven = row?.status === "ok";

  await ctx.goto(ctx.page, "/");
  const origin = new URL(ctx.page.url()).origin;
  const cookies = await ctx.page.context().cookies(origin);
  const c = cookies.find(
    (k) => k.name.startsWith("__Host-") && /session/.test(k.name),
  );
  const me = await ctx.page.evaluate(async () => {
    const r = await fetch("/api/session", { credentials: "same-origin" });
    const b = await r.json().catch(() => ({}));
    return { status: r.status, signedIn: !!b.signedIn };
  });
  await ctx.shot("601-signed-in");

  let port = 0;
  try {
    port = Number((await ctx.api("/api/server-info"))?.port) || 0;
  } catch {
    /* no port: the loopback clauses can't run */
  }
  const signin = port ? await loopback(port, "/signin") : null;

  const seen = {
    origin,
    https: origin.startsWith("https:"),
    cookie: c
      ? {
          name: c.name.replace(/[^_-]+$/, "…"),
          secure: c.secure,
          hostOnly: !c.domain.startsWith("."),
          path: c.path,
        }
      : null,
    me,
    proven,
    row: row ? { status: row.status, detail: row.detail } : null,
    port,
    signin,
  };
  ctx.log?.(`601: ${JSON.stringify(seen)}`);
  return seen;
}

export function expect(cells) {
  const r = (Array.isArray(cells) ? cells[0]?.result : cells) ?? {};
  const toAddress =
    r.signin?.status === 303 &&
    r.origin &&
    r.signin.location.startsWith(r.origin) &&
    !r.signin.cookie;
  return [
    !r.https
      ? { clause: clauses[0], ok: null, skip: "needs-https-address" }
      : {
          clause: clauses[0],
          ok: !!(
            r.cookie?.secure &&
            r.cookie.hostOnly &&
            r.cookie.path === "/" &&
            r.me?.signedIn
          ),
          note: `cookie ${JSON.stringify(r.cookie)}; /api/session ${r.me?.status} signedIn ${r.me?.signedIn}`,
          evidence: ["601-signed-in"],
        },
    !r.proven || !r.port
      ? {
          clause: clauses[1],
          ok: null,
          skip: r.port ? "needs-proven-address" : "needs-loopback-port",
        }
      : {
          clause: clauses[1],
          ok: !!toAddress,
          note: `loopback /signin → ${r.signin?.status} ${r.signin?.location ? "to the address" : "no Location"}${r.signin?.cookie ? ", set a cookie" : ""}`,
        },
    r.proven || !r.port
      ? {
          clause: clauses[2],
          ok: null,
          skip: r.port ? "needs-no-https-address" : "needs-loopback-port",
        }
      : {
          clause: clauses[2],
          ok: r.signin?.status === 200,
          note: `loopback /signin → ${r.signin?.status}`,
        },
    {
      clause: clauses[3],
      ok:
        !!r.row && (r.proven ? r.row.status === "ok" : r.row.status === "warn"),
      note: r.row
        ? `${r.row.status}: ${String(r.row.detail).slice(0, 120)}`
        : "no signin_host row",
    },
  ];
}
