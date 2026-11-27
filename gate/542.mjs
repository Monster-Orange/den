// Live check for PR 542: sign-in on this machine too. A request with no
// session and no token, even from this machine, changes nothing and runs
// nothing: a write or a GET that runs a command is asked to sign in (401).
// A plain read still answers. The signed-in person is unaffected.
//
// Look only, on this machine (542's promise: "a browser that isn't signed
// in can still read every page ... in one plain line with a Sign in
// button"): the bed has no browser on this machine (its browser lives in
// the box), so this checks, from the bed's loopback, what the shell shows
// that line from: GET / serves the page (200, not the sign-in page), and
// GET /api/session answers signedIn false with no actor and no CSRF token,
// the exact case shell.js's signinBanner shows the line and Sign in for.
// The line itself, in a real browser on this machine, is pinned by
// tests/unit/server/signin-this-machine.browser.test.ts.
//
// A browser from beyond this machine: the box's browser reaches Den
// through the edge from a container network, which Den can't place, so it
// signs in by design (docs/distributions.md, "web.edge_unattested": a
// container or VM network's address "signs in"; request-guard.ts, the
// `beyond` rule). It gets the sign-in page, which starts no sign-in
// request until asked (issue 1333).
//
// Nothing here changes the bed: the only write is a sign-out with no
// session.
export const issue = 542;
export const clauses = [
  "with no session or token, a write on this machine is asked to sign in (401)",
  "with no session or token, a GET that runs a command is asked to sign in (401)",
  "with no session or token, a plain read still answers",
  "the signed-in person still lists repos and reads settings",
  "with no session, a page on this machine opens to look: the page is served, and the session says signed out, the case the shell shows its one line and Sign in for",
  "a browser from beyond this machine with no session gets the sign-in page, and it starts no sign-in request until asked",
];
export const matrix = { browsers: ["chromium"], widths: [1280] };
export const timeoutMs = 90000;

// The sign-in page's marks (error-page.js): its heading line, and the
// button that starts a request. A request already on screen shows its code
// (#den-pair-code) and countdown (#den-pair-left).
const SIGNED_OUT_SUB = "This browser isn't signed in";

/**
 * A request with nothing: no cookie, no bearer, no Origin. It runs on the
 * host, so it goes to the bed's own loopback address (ctx.hostUrl), never the
 * browser's address (ctx.url), which only resolves inside the browser's box.
 */
async function bare(ctx, path, method = "GET") {
  if (!ctx.hostUrl) return { status: 0, code: "no-host-url" };
  try {
    const r = await fetch(new URL(path, ctx.hostUrl), {
      method,
      redirect: "manual",
      headers: method === "GET" ? {} : { "content-type": "application/json" },
      ...(method === "GET" ? {} : { body: "{}" }),
    });
    let code = "";
    try {
      code = String((await r.json())?.code ?? "");
    } catch {
      /* not JSON */
    }
    return { status: r.status, code };
  } catch (e) {
    return { status: 0, code: String(e?.message ?? e).slice(0, 80) };
  }
}

/**
 * GET / with nothing, from the bed's loopback: the page itself, read as
 * text. The sign-in page is served inside the shell too, but with its
 * polls off (`data-api-off="1"` on #den-shell, index.ts sendErrorPage) and
 * its code, signin_required; a page to look at has neither.
 */
async function lookPage(ctx) {
  if (!ctx.hostUrl) return { status: 0 };
  try {
    const r = await fetch(new URL("/", ctx.hostUrl), { redirect: "manual" });
    const html = await r.text().catch(() => "");
    return {
      status: r.status,
      // An installed Den stamps its asset URLs (asset-stamp.ts: ?v=<version>).
      shell: /<script src="\/shell\.js(\?v=[^"]*)?"><\/script>/.test(html),
      apiOff: html.includes('data-api-off="1"'),
      signin: html.includes("signin_required"),
    };
  } catch (e) {
    return { status: 0, error: String(e?.message ?? e).slice(0, 80) };
  }
}

/** GET /api/session with nothing, from the bed's loopback, as the shell asks. */
async function session(ctx) {
  if (!ctx.hostUrl) return { status: 0 };
  try {
    const u = new URL("/api/session", ctx.hostUrl);
    const r = await fetch(u, {
      headers: { "sec-fetch-site": "same-origin", referer: u.origin + "/" },
    });
    const b = await r.json().catch(() => ({}));
    return {
      status: r.status,
      signedIn: b?.signedIn,
      actor: b?.actor ?? null,
      csrf: b?.csrf ?? null,
    };
  } catch (e) {
    return { status: 0, error: String(e?.message ?? e).slice(0, 80) };
  }
}

export async function setup() {
  return {};
}

export async function run(ctx) {
  const write = await bare(ctx, "/api/session/logout", "POST");
  const runs = await bare(ctx, "/api/github/repos");
  const read = await bare(ctx, "/api/health");
  // Look only, on this machine: the shell page itself, from the bed's own
  // loopback address with nothing (issue 542's look-only clause).
  const look = await lookPage(ctx);
  const lookSession = await session(ctx);
  const signedRepos = (await ctx.fetch("/api/github/repos")).status;
  const signedSettings = (await ctx.fetch("/api/settings")).status;

  let page = { signin: false, title: false, button: false, asked: false };
  const out = await ctx.signedOut(ctx.browser, ctx.width);
  try {
    await ctx.goto(out.page, "/");
    const ms = await ctx.until(
      async () =>
        (await out.page.content()).includes(SIGNED_OUT_SUB) &&
        (await out.page.locator("#den-pair-start").count()) > 0,
      15000,
    );
    // A request started by itself showed its code at once (before issue
    // 1333): watch a while for its code or countdown.
    const askedMs = await ctx.until(
      async () =>
        (await out.page.locator("#den-pair-code, #den-pair-left").count()) > 0,
      3000,
    );
    page = {
      signin: (await out.page.content()).includes(SIGNED_OUT_SUB),
      title: /<title>/.test(await out.page.content()),
      button: ms !== null,
      asked: askedMs !== null,
    };
    await ctx.shotOf(out.page, "542-signed-out");
  } finally {
    await out.ctx?.close?.().catch(() => undefined);
  }
  const seen = {
    write,
    runs,
    read,
    look,
    lookSession,
    signedRepos,
    signedSettings,
    page,
  };
  ctx.log?.(`542: ${JSON.stringify(seen)}`);
  return seen;
}

export function expect(cells) {
  const r = (Array.isArray(cells) ? cells[0]?.result : cells) ?? {};
  const note = (x) => `${x?.status} ${x?.code ?? ""}`.trim();
  return [
    {
      clause: clauses[0],
      ok: r.write?.status === 401 && r.write?.code === "signin_required",
      note: `POST /api/session/logout → ${note(r.write)}`,
    },
    {
      clause: clauses[1],
      ok: r.runs?.status === 401 && r.runs?.code === "signin_required",
      note: `GET /api/github/repos → ${note(r.runs)}`,
    },
    {
      clause: clauses[2],
      ok: r.read?.status === 200,
      note: `GET /api/health → ${note(r.read)}`,
    },
    {
      clause: clauses[3],
      ok:
        r.signedRepos !== 401 &&
        r.signedRepos !== 403 &&
        r.signedSettings === 200,
      note: `signed in: repos ${r.signedRepos}, settings ${r.signedSettings}`,
    },
    {
      clause: clauses[4],
      ok:
        r.look?.status === 200 &&
        r.look?.shell === true &&
        r.look?.apiOff === false &&
        r.look?.signin === false &&
        r.lookSession?.status === 200 &&
        r.lookSession?.signedIn === false &&
        r.lookSession?.actor === null &&
        r.lookSession?.csrf === null,
      note: `GET / → ${r.look?.status}, shell ${r.look?.shell}, polls off ${r.look?.apiOff}, sign-in code ${r.look?.signin}; session ${r.lookSession?.status} signedIn ${r.lookSession?.signedIn}, actor ${r.lookSession?.actor}, csrf ${r.lookSession?.csrf === null ? "none" : "set"}`,
    },
    {
      clause: clauses[5],
      ok: !!(
        r.page?.signin &&
        r.page?.title &&
        r.page?.button &&
        r.page?.asked === false
      ),
      note: `sign-in page ${!!r.page?.signin}, button ${!!r.page?.button}, request started by itself ${!!r.page?.asked}`,
      evidence: ["542-signed-out"],
    },
  ];
}
