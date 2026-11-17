/* eslint-env browser */
// Live check for #393: Settings › Browser sign-in has a Sign in button (never "run a command"), and no
// Settings row tells the person to run, type or paste a command. Read only.
export const issue = 393;
export const clauses = [
  "not signed in, the row shows a Sign in button that opens Den's own sign-in page",
  "signed in, the row has Sign out and no Sign in",
  "no Settings string tells the person to run, type or paste a command",
  "en/es/ja",
];
export const matrix = { browsers: ["chromium", "webkit"], widths: [1280] };
export const timeoutMs = 120000;

// A code element right after "run", "type", "paste" or "enter" in a row's words is a chore.
const chores = () =>
  [...document.querySelectorAll(".set-row")].flatMap((row) =>
    [...row.querySelectorAll("code")]
      .filter((c) => {
        const before = c.previousSibling?.textContent ?? "";
        return /\b(run|type|paste|enter|ejecuta|escribe|pega|実行|入力|貼り付け)\b\s*:?\s*$/i.test(
          before,
        );
      })
      .map(
        (c) =>
          `${row.getAttribute("data-setting")}: …${(c.previousSibling?.textContent ?? "").slice(-30)}${c.textContent}`,
      ),
  );

export async function setup() {
  return {};
}

export async function run(ctx) {
  const tag = `${ctx.browser}-${ctx.width}`;
  const r = {};
  // Signed in (the cell's own page).
  await ctx.goto(ctx.page, "/settings#cli");
  await ctx.page
    .locator("#set-signout, #set-signin")
    .first()
    .waitFor({ timeout: 20000 })
    .catch(() => {});
  r.inSignout = await ctx.page.locator("#set-signout").count();
  r.inSignin = await ctx.page.locator("#set-signin").count();
  await ctx.page
    .waitForSelector(".set-row[data-setting]", { timeout: 15000 })
    .catch(() => {});
  r.chores = await ctx.page.evaluate(chores);
  r.rows = await ctx.page.locator(".set-row[data-setting]").count();
  await ctx.shot(`signed-in-${tag}`);

  // Signed out: a fresh browser with no session.
  const out = await ctx.signedOut(ctx.browser, ctx.width);
  try {
    await ctx.goto(out.page, "/settings#cli");
    const btn = out.page.locator("#set-signin");
    r.outButton = await btn.waitFor({ timeout: 10000 }).then(
      () => true,
      () => false,
    );
    r.outLanded = new URL(out.page.url()).pathname;
    if (r.outButton) {
      r.outRow = ((await btn.locator("xpath=..").textContent()) ?? "")
        .replace(/\s+/g, " ")
        .trim();
      r.outLabel = (await btn.textContent())?.trim() ?? null;
      await ctx.shotOf(out.page, `signed-out-${tag}`);
      await btn.click();
      await out.page
        .waitForURL(/\/signin\?again=1&next=/, { timeout: 15000 })
        .catch(() => {});
      r.outNext = new URL(out.page.url()).searchParams.get("next");
      r.outSigninPage = await out.page
        .locator("#den-signin")
        .waitFor({ timeout: 15000 })
        .then(
          () => true,
          () => false,
        );
    } else {
      r.outSigninPage = await out.page
        .locator("#den-signin")
        .count()
        .then((n) => n > 0);
    }
  } finally {
    await out.ctx.close().catch(() => {});
  }
  return r;
}

export function expect(cells) {
  const all = (f) => cells.every(({ result }) => f(result));
  const d = (f) =>
    cells.map(({ cell, result }) => `${cell.browser}: ${f(result)}`).join("; ");
  const shots = (p) =>
    cells.map(({ cell }) => `${p}-${cell.browser}-${cell.width}.png`);
  // Through the edge a signed-out browser is sent to the sign-in page before Settings draws; only a
  // loopback browser (where nothing asks) sees the signed-out row.
  const sawRow = all((r) => r.outButton);
  return [
    sawRow
      ? {
          clause: clauses[0],
          ok: all(
            (r) =>
              /Not signed in/.test(r.outRow) &&
              !/\brun\b|web login/i.test(r.outRow) &&
              r.outLabel === "Sign in" &&
              r.outNext === "/settings#cli" &&
              r.outSigninPage,
          ),
          detail: d(
            (r) =>
              `"${r.outRow}", button "${r.outLabel}", next ${r.outNext}, sign-in page ${r.outSigninPage}`,
          ),
          evidence: shots("signed-out"),
        }
      : {
          clause: clauses[0],
          ok: null,
          skip: "needs-loopback-browser",
          detail: d(
            (r) =>
              `signed out, /settings landed on ${r.outLanded} (sign-in page ${r.outSigninPage})`,
          ),
        },
    {
      clause: clauses[1],
      ok: all((r) => r.inSignout > 0 && r.inSignin === 0),
      detail: d((r) => `Sign out ${r.inSignout}, Sign in ${r.inSignin}`),
      evidence: shots("signed-in"),
    },
    {
      clause: clauses[2],
      ok: all((r) => r.rows > 0 && r.chores.length === 0),
      detail: d(
        (r) =>
          `${r.rows} rows; ${r.chores.length ? r.chores.join(" | ") : "none tells the person to run a command"}`,
      ),
      evidence: shots("signed-in"),
    },
    {
      clause: clauses[3],
      ok: null,
      skip: "needs-language-switch",
      detail: "reading es and ja means changing the bed's language setting",
    },
  ];
}
