/* eslint-env browser */
export const issue = 406;
export const items = [406];
export const clauses = [
  "with the person's name known, the rail's account entry is two lines: the name, then @login",
  "each line is one line, cut short with an ellipsis, the second smaller than the first, as the kit draws it",
];
export const matrix = { browsers: ["chromium", "webkit"], widths: [1280] };
export const timeoutMs = 600000;

export const OWNER = {
  v: 1,
  owner: "github:4060000406",
  login: "gate-406-person-login-that-runs-long",
  name: "Gate 406 Person With A Display Name Far Too Long For The Rail Entry",
};

let D2 = null;

export async function setup(ctx) {
  if (!ctx.den2) return { skip: "needs-den2" };
  try {
    D2 = await ctx.den2({ product: { testInstall: true } });
  } catch (e) {
    return { skip: "needs-den2", why: String(e?.message ?? e).slice(0, 200) };
  }
  const fs = await import("fs");
  const path = await import("path");
  const file = path.join(D2.o.denHome, "web-owner.json");
  fs.writeFileSync(
    file,
    JSON.stringify({ ...OWNER, linkedAt: new Date().toISOString() }),
    { mode: 0o600 },
  );
  return { file };
}

export async function run(ctx, s) {
  const tag = `${ctx.browser}-${ctx.width}`;
  if (s?.skip || !D2) return { tag, skip: s?.skip ?? "needs-den2", entry: [] };
  const { ctx: bc, page } = await D2.signedIn(ctx.browser, ctx.width);
  try {
    return await measure(ctx, D2, page, tag);
  } finally {
    await bc.close().catch(() => {});
  }
}

export async function teardown() {
  const d = D2;
  D2 = null;
  if (!d) return;
  try {
    (await import("fs")).rmSync(
      (await import("path")).join(d.o.denHome, "web-owner.json"),
      { force: true },
    );
  } finally {
    await d.close().catch(() => {});
  }
}

async function measure(ctx, d2, page, tag) {
  await d2.goto(page, "/services");
  await page.waitForFunction(
    () =>
      document.getElementById("den-ident")?.getElementsByClassName("den-acct")
        .length > 0,
    undefined,
    { timeout: 20000 },
  );
  await page.evaluate(() => document.fonts.ready.then(() => true));
  const session = await page.evaluate(async () => {
    const r = await fetch("/api/session", { cache: "no-store" });
    try {
      return await r.json();
    } catch {
      return null;
    }
  });
  const entry = await page.evaluate(() => {
    const [lbl] = document
      .getElementById("den-ident")
      .getElementsByClassName("den-acct");
    const cs = (e) => getComputedStyle(e);
    const lines = [...lbl.children].filter((c) => cs(c).display !== "none");
    return lines.map((c) => {
      const k = cs(c);
      const r = c.getBoundingClientRect();
      return {
        cls: c.className,
        text: (c.textContent ?? "").trim(),
        top: Math.round(r.top),
        height: Math.round(r.height * 10) / 10,
        fontSize: parseFloat(k.fontSize),
        lineHeight: parseFloat(k.lineHeight) || parseFloat(k.fontSize) * 1.3,
        textOverflow: k.textOverflow,
        whiteSpace: k.whiteSpace,
      };
    });
  });
  await page
    .locator("#den-ident")
    .screenshot({ path: ctx.evidence(`${tag}-entry.png`) });
  const id = session?.identity ?? null;
  const gh =
    id?.kind === "github" && id.login
      ? id
      : id?.kind === "local" && id.owner?.login
        ? id.owner
        : null;
  const name =
    typeof gh?.name === "string" &&
    gh.name.trim() &&
    gh.name.trim().toLowerCase() !== String(gh.login).toLowerCase()
      ? gh.name.trim()
      : null;
  return { tag, name, login: gh?.login ?? null, entry };
}

export function expect(cells) {
  const rs = cells.map((c) => c.result).filter(Boolean);
  const off = rs.find((r) => r.skip);
  if (off)
    return clauses.map((clause) => ({ clause, ok: null, skip: off.skip }));
  const say = (r) =>
    `${r.tag}: ${r.entry.map((l) => `"${l.text}" ${l.fontSize}px`).join(" over ")} (Den knows ${r.name ? `the name "${r.name}"` : "no name"})`;
  const two = (r) =>
    r.entry.length === 2 &&
    /den-acct-n/.test(r.entry[0].cls) &&
    /den-acct-l/.test(r.entry[1].cls) &&
    /^@\S+$/.test(r.entry[1].text) &&
    r.entry[1].top > r.entry[0].top &&
    (!r.name || r.entry[0].text === r.name);
  const named = rs.filter((r) => r.name || two(r));
  const look = (r) =>
    r.entry.every(
      (l) =>
        l.height < l.lineHeight * 1.5 &&
        l.whiteSpace === "nowrap" &&
        l.textOverflow === "ellipsis",
    ) &&
    (r.entry.length < 2 || r.entry[1].fontSize < r.entry[0].fontSize);
  return [
    named.length === 0
      ? {
          clause: clauses[0],
          ok: null,
          skip: "needs-person-name",
          detail: rs.map(say).join("; "),
        }
      : {
          clause: clauses[0],
          ok: named.length === rs.length && rs.every(two),
          detail: rs.map(say).join("; "),
          evidence: rs.map((r) => `${r.tag}-entry.png`),
        },
    {
      clause: clauses[1],
      ok: rs.length > 0 && rs.every(look),
      detail: rs
        .map(
          (r) =>
            `${r.tag}: ${r.entry.map((l) => `${l.height}px tall (line ${l.lineHeight}px), ${l.whiteSpace}, ${l.textOverflow}`).join(" / ")}`,
        )
        .join("; "),
      evidence: rs.map((r) => `${r.tag}-entry.png`),
    },
  ];
}
