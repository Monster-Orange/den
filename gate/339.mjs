/* eslint-env browser */
// Live check for #339: `agents accounts list` and Settings › Agents show each vendor's sign-in accounts by
// label and status, never a token or an email. Nothing is added, set, ordered or removed. Read only.
export const issue = 339;
export const clauses = [
  "`agents accounts` (list, add, set-token, order, remove) on the command line",
  "Settings › Agents shows the list per vendor: each token's status, Add account, Set sign-in token and reorder",
  "a token is never shown again after it is set",
  "no email appears in a store item name, a log or the UI",
  "the single token that exists today becomes account one",
];
export const matrix = { browsers: ["chromium", "webkit"], widths: [1280] };
export const timeoutMs = 90000;
const EMAIL = /[^\s@]+@[^\s@]+\.[a-z]{2,}/i;
const TOKENISH = /\b(sk-[A-Za-z0-9_-]{12,}|[A-Za-z0-9_-]{40,})\b/;

// Read only (issue 845): reads `agents accounts list` and Settings › Agents' accounts.
export const readOnly = true;

export async function setup(ctx) {
  // Issue 840: the list's --json form. `out` stays the whole printed
  // text, so the token and email checks below read every byte of it.
  const l = ctx.cli(["agents", "accounts", "list", "--json"]);
  let list = null;
  try {
    list = JSON.parse(String(l.out ?? ""));
  } catch {
    list = null;
  }
  return {
    code: l.code,
    out: String(l.out ?? ""),
    err: String(l.err ?? ""),
    runtime: list?.runtime ?? null,
    accounts: Array.isArray(list?.accounts) ? list.accounts : null,
  };
}

export async function run(ctx, s) {
  await ctx.goto(ctx.page, "/settings");
  await ctx.page
    .waitForSelector("[data-acct-runtime]", { timeout: 20000 })
    .catch(() => {});
  const seen = await ctx.page.evaluate(() => {
    const blocks = [...document.querySelectorAll("[data-acct-runtime]")];
    return {
      vendors: blocks.map((b) => ({
        runtime: b.getAttribute("data-acct-runtime"),
        add: !!b.querySelector("[data-acct-add]"),
        accounts: [...b.querySelectorAll("[data-acct]")].map((a) => ({
          status:
            a.querySelector("[data-acct-status]")?.textContent?.trim() ?? null,
          token: a.querySelector("input[data-acct-token]")?.type ?? null,
          tokenEmpty: !a.querySelector("input[data-acct-token]")?.value,
          save: !!a.querySelector("[data-acct-save]"),
          reorder:
            !!a.querySelector("[data-acct-up]") &&
            !!a.querySelector("[data-acct-down]"),
        })),
      })),
      text: blocks.map((b) => b.innerText).join("\n"),
    };
  });
  await ctx.page
    .locator("[data-acct-runtime]")
    .first()
    .scrollIntoViewIfNeeded()
    .catch(() => {});
  await ctx.shot(`accounts-${ctx.browser}-${ctx.width}`);
  return { ...s, seen };
}

export function expect(cells) {
  const r0 = cells[0].result;
  const shots = cells.map(
    ({ cell }) => `accounts-${cell.browser}-${cell.width}.png`,
  );
  const acctOk = (a) =>
    a.status && a.token === "password" && a.tokenEmpty && a.save && a.reorder;
  return [
    {
      clause: clauses[0],
      ok: r0.code === 0 && !!r0.runtime?.id && (r0.accounts?.length ?? 0) > 0,
      detail: `agents accounts list --json: ${r0.code}; ${r0.accounts ? `${r0.runtime?.name} (${r0.runtime?.id}): ${r0.accounts.map((a) => `${a.id} ${a.label} ${a.tokenSet ? "token set" : "no token"}`).join(" / ")}` : r0.err.slice(0, 120)} (add, set-token, order and remove change accounts: not run)`,
    },
    {
      clause: clauses[1],
      ok: cells.every(
        ({ result: r }) =>
          r.seen.vendors.length > 0 &&
          r.seen.vendors.every((v) => v.add && v.accounts.every(acctOk)),
      ),
      detail: cells
        .map(
          ({ cell, result: r }) =>
            `${cell.browser}: ${r.seen.vendors.map((v) => `${v.runtime} add ${v.add}, ${v.accounts.length} account(s) [${v.accounts.map((a) => a.status).join(", ")}]`).join("; ") || "no vendor list"}`,
        )
        .join(" | "),
      evidence: shots,
    },
    {
      clause: clauses[2],
      ok:
        !TOKENISH.test(r0.out) &&
        cells.every(
          ({ result: r }) =>
            !TOKENISH.test(r.seen.text) &&
            r.seen.vendors.every((v) => v.accounts.every((a) => a.tokenEmpty)),
        ),
      detail:
        "the list and the page show status only; every token field is empty",
      evidence: shots,
    },
    {
      clause: clauses[3],
      ok:
        !EMAIL.test(r0.out) &&
        cells.every(({ result: r }) => !EMAIL.test(r.seen.text)),
      detail:
        "no email in `agents accounts list` or the Settings list (store item names and logs: not read here)",
    },
    {
      clause: clauses[4],
      ok: null,
      skip: "needs-upgrade-from-single-token",
      detail: "needs an install upgraded from a single sign-in token",
    },
  ];
}
