// Live check for issue 699: a button the kit holds shows three pulsing
// dots in place of its label at once (.bz-dots, disabled, aria-busy="true",
// the same size, the label kept as its name), no pop-up opens for one
// request until the kit's NO_ANSWER_MS opens the no-answer one, and the
// label comes back on the answer.
//
// The button is Den's own Settings › Access "Start the edge" (busyAction
// "edge-up", the kit's held button). Its requests are answered by this
// module at the page's network, as tests/unit/server/settings-edge-up's
// browser test does: GET /api/web/pair (no edge hostname, so the button
// shows), GET /api/edge (not running), and POST /api/edge/up, held until
// the module lets it go. Nothing reaches the bed's server or its edge,
// and the routes live on a page of the module's own, closed after.
export const issue = 699;
export const clauses = [
  "a slow button shows the three dots at once: .bz-dots, disabled, aria-busy=\"true\", the same size, its label kept as its name",
  "no pop-up opens; at NO_ANSWER_MS the no-answer pop-up opens, with the dots still behind it",
  "on the answer the label comes back and the button is free again",
];
export const matrix = { browsers: ["chromium", "webkit"], widths: [1280] };
export const timeoutMs = 180000;

/** The kit's wait before a Working pop-up would open (busy.js DOTS_MS). */
const DOTS_MS = 3000;

export async function setup() {
  return {};
}

export async function run(ctx) {
  const p = await ctx.page.context().newPage();
  let answer = () => {};
  const held = new Promise((ok) => (answer = ok));
  let posts = 0;
  try {
    await p.addInitScript(() => {
      try {
        for (const k of Object.keys(localStorage))
          if (/-changelog-seen$/.test(k)) localStorage.setItem(k, "9.9.9");
      } catch {
        /* none */
      }
      document.addEventListener("DOMContentLoaded", () => {
        const st = document.createElement("style");
        st.textContent = "#cl-overlay{display:none!important}";
        document.head.appendChild(st);
      });
    });
    await p.route("**/api/web/pair", (r) =>
      r.request().method() === "GET"
        ? r.fulfill({ json: { hosts: [] } })
        : r.continue(),
    );
    await p.route("**/api/edge", (r) =>
      r.fulfill({ json: { configured: true, up: false } }),
    );
    await p.route("**/api/edge/up", async (r) => {
      posts++;
      await held;
      await r.fulfill({
        json: { ok: true, outcome: { kind: "current", changes: [] } },
      });
    });

    await ctx.goto(p, "/settings#access");
    const btn = p.locator("#set-edge-up");
    await btn.waitFor({ timeout: 20000 });
    await btn.scrollIntoViewIfNeeded();
    const label = ((await btn.textContent()) ?? "").trim();
    const box0 = await btn.boundingBox();

    // On the page's clock: when the click came, when the dots and the
    // pop-up first showed.
    await p.evaluate(() => {
      const w = window;
      w.g699 = { click: null, dots: null, popup: null, state: null };
      document.addEventListener(
        "click",
        (e) => {
          if (e.target?.closest?.("#set-edge-up") && w.g699.click == null)
            w.g699.click = performance.now();
        },
        true,
      );
      new MutationObserver(() => {
        const t = performance.now();
        if (w.g699.dots == null && document.querySelector("#set-edge-up .bz-dots"))
          w.g699.dots = t;
        const dlg = document.querySelector("dialog[open]");
        if (w.g699.popup == null && dlg) {
          w.g699.popup = t;
          w.g699.state = dlg.dataset.state ?? null;
        }
      }).observe(document.body, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ["open", "data-state"],
      });
    });

    await btn.click();
    await p
      .locator("#set-edge-up .bz-dots")
      .waitFor({ state: "attached", timeout: 2000 })
      .catch(() => {});
    const box1 = await btn.boundingBox();
    const now = await btn.evaluate((b) => ({
      dots: b.querySelectorAll(".bz-dots > i").length,
      dotsHidden: b.querySelector(".bz-dots")?.getAttribute("aria-hidden") ?? null,
      busy: b.getAttribute("aria-busy"),
      disabled: b.disabled,
      name: b.getAttribute("aria-label") ?? "",
      lbl: (b.querySelector(".bz-lbl")?.textContent ?? "").trim(),
      lblShown:
        !!b.querySelector(".bz-lbl") &&
        getComputedStyle(b.querySelector(".bz-lbl")).visibility !== "hidden",
    }));
    // The accessible name, as a screen reader gets it.
    const byName = await p
      .getByRole("button", { name: label, exact: true })
      .count()
      .catch(() => 0);
    await ctx.shotOf(p, `699-dots-${ctx.browser}`);

    const noAnswerMs = await p.evaluate(
      async () => (await import("/kit/busy.js")).NO_ANSWER_MS,
    );
    const popupSeen = await p
      .getByRole("dialog")
      .and(p.locator('[data-state="noanswer"]'))
      .waitFor({ timeout: noAnswerMs + 15000 })
      .then(() => true)
      .catch(() => false);
    const behind = await btn.evaluate((b) => ({
      dots: b.querySelectorAll(".bz-dots > i").length,
      busy: b.getAttribute("aria-busy"),
    }));
    if (popupSeen) await ctx.shotOf(p, `699-popup-${ctx.browser}`);
    const t = await p.evaluate(() => window.g699);

    answer();
    const back = await ctx.until(
      async () =>
        (await btn.evaluate(
          (b) => !b.disabled && !b.querySelector(".bz-dots") && !b.hasAttribute("aria-busy"),
        )) &&
        (await p.locator("dialog.bz-dlg[open]").count()) === 0,
      15000,
    );
    const end = {
      label: ((await btn.textContent()) ?? "").trim(),
      lbl: await btn.locator(".bz-lbl").count(),
      name: await btn.getAttribute("aria-label"),
    };

    const seen = {
      browser: ctx.browser,
      label,
      box0: box0 && { w: Math.round(box0.width), h: Math.round(box0.height) },
      box1: box1 && { w: Math.round(box1.width), h: Math.round(box1.height) },
      now,
      byName,
      dotsMs: t?.click != null && t?.dots != null ? Math.round(t.dots - t.click) : null,
      popupMs:
        t?.click != null && t?.popup != null ? Math.round(t.popup - t.click) : null,
      popupSeen,
      popupState: t?.state ?? null,
      noAnswerMs,
      behind,
      back,
      end,
      posts,
    };
    ctx.log?.(`699: ${JSON.stringify(seen)}`);
    return seen;
  } finally {
    answer();
    await p.unrouteAll({ behavior: "ignoreErrors" }).catch(() => {});
    await p.close().catch(() => {});
  }
}

export function expect(cells) {
  const list = Array.isArray(cells) ? cells : [{ cell: {}, result: cells }];
  const each = (fn) => list.map(({ cell, result }) => fn(result ?? {}, cell ?? {}));
  const who = (r, c) => r.browser ?? c.browser ?? "?";
  const sameSize = (r) =>
    !!r.box0 &&
    !!r.box1 &&
    Math.abs(r.box0.w - r.box1.w) <= 1 &&
    Math.abs(r.box0.h - r.box1.h) <= 1;
  const dots = (r) =>
    r.posts === 1 &&
    r.now?.dots === 3 &&
    r.now.dotsHidden === "true" &&
    r.now.busy === "true" &&
    r.now.disabled === true &&
    !!r.label &&
    r.now.name === r.label &&
    r.now.lbl === r.label &&
    !r.now.lblShown &&
    r.byName >= 1 &&
    sameSize(r) &&
    r.dotsMs != null &&
    r.dotsMs < 1000;
  // A loaded runner fires the kit's timer late, never early.
  const popup = (r) =>
    r.popupSeen &&
    r.popupState === "noanswer" &&
    Number.isFinite(r.noAnswerMs) &&
    r.popupMs != null &&
    r.popupMs >= r.noAnswerMs - 150 &&
    r.popupMs <= r.noAnswerMs + 10000 &&
    r.behind?.dots === 3 &&
    r.behind.busy === "true";
  const back = (r) =>
    !!r.back && r.end?.label === r.label && r.end.lbl === 0 && r.end.name == null;
  return [
    {
      clause: clauses[0],
      ok: list.length > 0 && each((r) => dots(r)).every(Boolean),
      detail: each(
        (r, c) =>
          `${who(r, c)}: "${r.label}" ${r.now?.dots ?? 0} dots ${r.dotsMs ?? "?"} ms after the click, aria-busy ${r.now?.busy}, disabled ${r.now?.disabled}, name "${r.now?.name}" (by role ${r.byName}), size ${JSON.stringify(r.box0)} → ${JSON.stringify(r.box1)}, ${r.posts ?? 0} request(s)`,
      ).join(" | "),
      evidence: list.map(({ result, cell }) => `699-dots-${who(result ?? {}, cell ?? {})}`),
    },
    {
      clause: clauses[1],
      ok: list.length > 0 && each((r) => popup(r)).every(Boolean),
      detail: each(
        (r, c) =>
          `${who(r, c)}: first pop-up ${r.popupMs != null ? `"${r.popupState}" ${r.popupMs} ms after the click` : "never opened"}, NO_ANSWER_MS ${r.noAnswerMs ?? "?"}; behind it ${r.behind?.dots ?? 0} dots, aria-busy ${r.behind?.busy}`,
      ).join(" | "),
      evidence: list.map(({ result, cell }) => `699-popup-${who(result ?? {}, cell ?? {})}`),
    },
    {
      clause: clauses[2],
      ok: list.length > 0 && each((r) => back(r)).every(Boolean),
      detail: each(
        (r, c) =>
          `${who(r, c)}: ${r.back ? "free again" : "still held"}, label "${r.end?.label}", .bz-lbl ${r.end?.lbl}, aria-label ${r.end?.name ?? "none"}`,
      ).join(" | "),
    },
  ];
}
