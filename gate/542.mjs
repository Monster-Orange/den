// Live check for PR 542: sign-in on this machine too. A request with no
// session and no token, even from this machine, changes nothing and runs
// nothing: a write or a GET that runs a command is asked to sign in (401).
// A plain read still answers. The signed-in person is unaffected. Nothing
// here changes the bed: the only write is a sign-out with no session.
export const issue = 542;
export const clauses = [
  "with no session or token, a write on this machine is asked to sign in (401)",
  "with no session or token, a GET that runs a command is asked to sign in (401)",
  "with no session or token, a plain read still answers",
  "the signed-in person still lists repos and reads settings",
  "a browser with no session shows the sign-in line, and can still look",
];
export const matrix = { browsers: ["chromium"], widths: [1280] };
export const timeoutMs = 90000;

const LINE = "Sign in to make changes here.";

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

export async function setup() {
  return {};
}

export async function run(ctx) {
  const write = await bare(ctx, "/api/session/logout", "POST");
  const runs = await bare(ctx, "/api/github/repos");
  const read = await bare(ctx, "/api/health");
  const signedRepos = (await ctx.fetch("/api/github/repos")).status;
  const signedSettings = (await ctx.fetch("/api/settings")).status;

  let page = { line: false, title: false };
  const out = await ctx.signedOut(ctx.browser, ctx.width);
  try {
    await ctx.goto(out.page, "/");
    const ms = await ctx.until(
      async () => (await out.page.content()).includes(LINE),
      15000,
    );
    page = {
      line: ms !== null,
      title: /<title>/.test(await out.page.content()),
    };
    await ctx.shotOf(out.page, "542-signed-out");
  } finally {
    await out.ctx?.close?.().catch(() => undefined);
  }
  const seen = { write, runs, read, signedRepos, signedSettings, page };
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
      ok: !!(r.page?.line && r.page?.title),
      evidence: ["542-signed-out"],
    },
  ];
}
