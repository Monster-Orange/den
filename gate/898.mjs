/* eslint-env browser */
// Live check for issue 898: on an iPad the project drop-down's checkmark
// wrapped onto a line of its own. Each cell opens the Services page signed in
// as the bed's person, in a touch context of its own at iPad sizes (the
// cell's browser, the page's own sign-in), opens the project picker and
// measures the checked row (the project in view, or All projects). Read only
// (issue 898): opens the picker's menu, which only changes the view; it
// never picks a project.
export const issue = 898;
export const items = [898];
export const readOnly = true;
export const clauses = [
  "on an iPad (touch, portrait and landscape) the drop-down's checked row is one line, its ✓ at the end of that line",
];
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

export async function setup() {
  return {};
}

export async function run(ctx) {
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
        return {
          text: row.firstElementChild.textContent,
          rowH: Math.round(r.height * 10) / 10,
          padY: parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom),
          line: Math.round(line * 10) / 10,
          parts: Array.from(row.children).map(
            (c) => Math.round(c.getBoundingClientRect().height * 10) / 10,
          ),
          labelRight: Math.round(l.right),
          rowRight: Math.round(r.right),
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
  const say = (r) =>
    r.error
      ? `${r.tag}: ${r.error}`
      : `${r.tag}: "${r.text}" row ${r.rowH}px (line ${r.line}px + padding ${r.padY}px), mark ${r.mark} ${r.markPos}, label ends ${r.rowRight - r.labelRight}px before the row's end`;
  return [
    {
      clause: clauses[0],
      ok: all.length > 0 && all.every(good),
      detail: all.map(say).join("; "),
      evidence: all.map((r) => `${r.tag}.png`),
    },
  ];
}
