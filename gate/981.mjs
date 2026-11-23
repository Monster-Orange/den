/* eslint-env browser */
// Live check for issue 981: on a tablet the top bar's Search box covered the
// project picker, so a tap on the picker opened Search. Each cell opens the
// Services page signed in as the bed's person, in a touch context of its own
// at an iPad's sizes (the cell's browser, the page's own sign-in), measures
// the picker and Search, then taps the picker. Read only (issue 981): reads
// the top bar and opens the picker's menu, which only changes the view.
export const issue = 981;
export const items = [981];
export const readOnly = true;
export const clauses = [
  "on a tablet (768 x 1024 and 820 x 1180, touch) the Search box doesn't cover the project picker",
  "a tap on the project picker opens the projects, not Search",
];
export const matrix = { browsers: ["webkit", "chromium"], widths: [1280] };
export const timeoutMs = 120000;

const SIZES = [
  [768, 1024],
  [820, 1180],
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
      const bar = await p.evaluate(() => {
        const box = (id) => {
          const r = document.getElementById(id).getBoundingClientRect();
          return {
            left: Math.round(r.left),
            right: Math.round(r.right),
            top: Math.round(r.top),
            bottom: Math.round(r.bottom),
          };
        };
        const pill = box("ws-pill");
        const search = box("den-search");
        const at = document.elementFromPoint(
          (pill.left + pill.right) / 2,
          (pill.top + pill.bottom) / 2,
        );
        return {
          pill,
          search,
          atPill: !!at?.closest("#ws-pill"),
          coarse: matchMedia("(pointer: coarse)").matches,
        };
      });
      await p.screenshot({ path: ctx.evidence(`${tag}.png`) });
      const pb = await p.locator("#ws-pill").boundingBox();
      await p.touchscreen.tap(pb.x + pb.width / 2, pb.y + pb.height / 2);
      const menu = await p
        .waitForSelector('[role="menuitemradio"]', { timeout: 5000 })
        .then(
          () => true,
          () => false,
        );
      const searchOpen =
        (await p.getAttribute("#den-search", "aria-expanded")) === "true";
      await p.screenshot({ path: ctx.evidence(`${tag}-tapped.png`) });
      out.push({ tag, ...bar, menu, searchOpen });
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
  const errs = all.filter((r) => r.error);
  const clear = all.filter(
    (r) => !r.error && r.coarse && r.atPill && r.pill.right <= r.search.left,
  );
  const tapped = all.filter((r) => !r.error && r.menu && !r.searchOpen);
  const say = (r) =>
    r.error
      ? `${r.tag}: ${r.error}`
      : `${r.tag}: picker x ${r.pill.left} to ${r.pill.right}, Search from x ${r.search.left}, at the picker's middle: ${r.atPill ? "the picker" : "something else"}; tap: ${r.menu ? "projects menu" : "no menu"}${r.searchOpen ? ", Search opened" : ""}`;
  return [
    {
      clause: clauses[0],
      ok: errs.length === 0 && clear.length === all.length && all.length > 0,
      detail: all.map(say).join("; "),
      evidence: all.map((r) => `${r.tag}.png`),
    },
    {
      clause: clauses[1],
      ok: errs.length === 0 && tapped.length === all.length && all.length > 0,
      detail: all.map(say).join("; "),
      evidence: all.map((r) => `${r.tag}-tapped.png`),
    },
  ];
}
