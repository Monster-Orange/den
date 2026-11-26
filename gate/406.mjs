/* eslint-env browser */
export const issue = 406;
export const items = [406];
export const readOnly = true;
export const clauses = [
  "with the person's name known, the rail's account entry is two lines: the name, then @login",
  "each line is one line, cut short with an ellipsis, the second smaller than the first, as the kit draws it",
];
export const matrix = { browsers: ["chromium", "webkit"], widths: [1280] };
export const timeoutMs = 90000;

export async function setup() {
  return {};
}

export async function run(ctx) {
  const tag = `${ctx.browser}-${ctx.width}`;
  await ctx.goto(ctx.page, "/services");
  await ctx.page.waitForFunction(
    () =>
      document.getElementById("den-ident")?.getElementsByClassName("den-acct")
        .length > 0,
    undefined,
    { timeout: 20000 },
  );
  await ctx.page.evaluate(() => document.fonts.ready.then(() => true));
  const session = await ctx.page.evaluate(async () => {
    const r = await fetch("/api/session", { cache: "no-store" });
    try {
      return await r.json();
    } catch {
      return null;
    }
  });
  const entry = await ctx.page.evaluate(() => {
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
  await ctx.page
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
