/* eslint-env browser */
// Live check for issue 898: on an iPad the project drop-down's checkmark
// wrapped onto a line of its own. Setup makes a throwaway project with a long
// name, activates it and puts it in view, so it is the checked row. Each cell
// opens the Services page signed in as the bed's person, in a touch context
// of its own at iPad sizes (the cell's browser, the page's own sign-in),
// opens the project picker and measures that row. Teardown puts the person's
// view back, deactivates the project and deletes it.
export const issue = 898;
export const items = [898];
export const clauses = [
  "on an iPad (touch, portrait and landscape) the drop-down's checked row is one line, its ✓ at the end of that line",
  "a long project name is cut short with an ellipsis instead of wrapping",
];

/** Long enough that no iPad-width row holds it on one line. */
export const LONG_NAME = "Gate 898 a project whose name runs well past the row";

const json = (method, body) => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});
export const matrix = { browsers: ["webkit", "chromium"], widths: [1280] };
export const timeoutMs = 120000;

const SIZES = [
  [820, 1180],
  [1024, 1366],
  [1180, 820],
];

/** A touch page at `width` x `height`, signed in as the cell's page is. */
async function touchPage(ctx, width, height) {
  const base = ctx.page.context();
  const c = await base.browser().newContext({
    storageState: await base.storageState(),
    ignoreHTTPSErrors: true,
    viewport: { width, height },
    hasTouch: true,
    isMobile: true,
    reducedMotion: "reduce",
  });
  // As the bed does: What's new never covers the page under test.
  await c.addInitScript(() =>
    document.addEventListener("DOMContentLoaded", () => {
      const s = document.createElement("style");
      s.textContent = "#cl-overlay{display:none!important}";
      document.head.appendChild(s);
    }),
  );
  const p = await c.newPage();
  await p.goto(`${ctx.url}/services`, { waitUntil: "networkidle" });
  return p;
}

export async function setup(ctx) {
  const s = { viewWas: (await ctx.api("/api/scope"))?.scope ?? "all" };
  const made = await ctx.api(
    "/api/workspaces/create",
    json("POST", { name: LONG_NAME }),
  );
  if (!made?.slug) {
    s.error = `couldn't make the long-named project: ${JSON.stringify(made).slice(0, 160)}`;
    return s;
  }
  s.slug = made.slug;
  await ctx.api(
    "/api/workspaces",
    json("POST", { name: s.slug, action: "activate" }),
  );
  const view = await ctx.api("/api/scope", json("POST", { scope: s.slug }));
  if (view?.scope !== s.slug)
    s.error = `couldn't put it in view: ${JSON.stringify(view).slice(0, 160)}`;
  return s;
}

export async function teardown(ctx, s) {
  if (s?.viewWas)
    await ctx.api("/api/scope", json("POST", { scope: s.viewWas }));
  if (!s?.slug) return;
  await ctx.api(
    "/api/workspaces",
    json("POST", { name: s.slug, action: "deactivate" }),
  );
  await ctx.api(
    "/api/workspaces",
    json("DELETE", { name: s.slug, agents: "stop" }),
  );
}

export async function run(ctx, s) {
  if (s?.error) return [{ tag: ctx.browser, error: s.error }];
  const out = [];
  for (const [w, h] of SIZES) {
    const tag = `${ctx.browser}-${w}x${h}`;
    const p = await touchPage(ctx, w, h);
    try {
      await p.waitForSelector("#ws-pill:not([hidden])", { timeout: 15000 });
      const pb = await p.locator("#ws-pill").boundingBox();
      await p.touchscreen.tap(pb.x + pb.width / 2, pb.y + pb.height / 2);
      const sel = '[role="menuitemradio"][aria-checked="true"]';
      await p.waitForSelector(sel, { timeout: 5000 });
      const row = await p.$eval(sel, (row) => {
        const r = row.getBoundingClientRect();
        const l = row.firstElementChild.getBoundingClientRect();
        const cs = getComputedStyle(row);
        const line = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.3;
        const after = getComputedStyle(row, "::after");
        const lab = row.firstElementChild;
        const ls = getComputedStyle(lab);
        return {
          text: lab.textContent,
          // Cut short: the label's text is wider than its box, with an ellipsis.
          cut: lab.scrollWidth > lab.clientWidth,
          ellipsis: ls.textOverflow === "ellipsis",
          nowrap: ls.whiteSpace === "nowrap",
          rowH: Math.round(r.height * 10) / 10,
          padY: parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom),
          line: Math.round(line * 10) / 10,
          parts: Array.from(row.children).map(
            (c) => Math.round(c.getBoundingClientRect().height * 10) / 10,
          ),
          labelRight: Math.round(l.right),
          rowRight: Math.round(r.right),
          // How long the label is against the row: a short one can't wrap.
          labelW: Math.round(row.firstElementChild.scrollWidth),
          rowW: Math.round(r.width),
          mark: after.content,
          markPos: after.position,
          coarse: matchMedia("(pointer: coarse)").matches,
        };
      });
      await p.screenshot({ path: ctx.evidence(`${tag}.png`) });
      out.push({ tag, ...row });
    } catch (e) {
      out.push({ tag, error: String(e).slice(0, 200) });
    } finally {
      await p.context().close();
    }
  }
  return out;
}

export function expect(cells) {
  const all = cells.flatMap((c) => c.result ?? []);
  const good = (r) =>
    !r.error &&
    r.coarse &&
    /✓/.test(r.mark) &&
    r.markPos === "static" &&
    r.rowH < r.line * 1.5 + r.padY &&
    r.parts.every((h) => h < r.line * 1.5) &&
    r.labelRight < r.rowRight - 8;
  const cut = (r) =>
    good(r) && r.text === LONG_NAME && r.cut && r.ellipsis && r.nowrap;
  const say = (r) =>
    r.error
      ? `${r.tag}: ${r.error}`
      : `${r.tag}: "${r.text}" (label ${r.labelW}px of a ${r.rowW}px row${r.cut ? ", cut short" : ""}${r.ellipsis ? " with an ellipsis" : ""}) row ${r.rowH}px (line ${r.line}px + padding ${r.padY}px), mark ${r.mark} ${r.markPos}, label ends ${r.rowRight - r.labelRight}px before the row's end`;
  const ok = (f) => all.length > 0 && all.every(f);
  const detail = all.map(say).join("; ");
  const evidence = all.map((r) => `${r.tag}.png`);
  return [
    { clause: clauses[0], ok: ok(good), detail, evidence },
    { clause: clauses[1], ok: ok(cut), detail, evidence },
  ];
}
