/**
 * den-ui: the pager (pager.js, DS component #2), the checks that need no
 * browser. pagerHtml, cursorHref and cursorStart are pure: they run in Node.
 *
 *   - pages with a total: the range, the four ends as icon buttons (no
 *     visible word; aria-label is the *Sr word, title the word), the page
 *     picker, the per-page choice; ends off on page 1 and the last page
 *   - no total: Previous and Next, First from page 2, no Last or picker
 *   - over 500 pages: a number field with Go
 *   - one page: nothing, unless the person chose a size other than
 *     perDefault
 *   - compact: Previous, a page field and Next, plus First and Last
 *   - number runs isolated left to right; es and ja words; escaping
 *   - more mode: Show 50 more, the last chunk, All N shown with loaded
 *   - cursorHref and cursorStart: the trail, the cap, the offset
 *
 * The browser half is pager-kit.browser.test.ts.
 */
import { describe, expect, it } from "@jest/globals";
import {
  cursorHref,
  cursorStart,
  pagerHtml,
} from "../../../packages/den-ui/src/pager.js";

const EN = {
  range: "{from}–{to} of {total}",
  rangeOpen: "{from}–{to}",
  label: "Pages",
  first: "First",
  firstSr: "First page",
  prev: "Previous",
  prevSr: "Previous page",
  next: "Next",
  nextSr: "Next page",
  last: "Last",
  lastSr: "Last page",
  pageOf: "Page {select} of {n}",
  pageShort: "{p} / {n}",
  pageSr: "Page {p} of {n}",
  go: "Go",
  perPage: "{select} per page",
  more: "More",
  moreN: "Show {n} more",
  lastN: "Show the last {n}",
  all: "All {total} shown",
  moreErr: "Couldn't load more.",
};
const ES = {
  ...EN,
  range: "{from}–{to} de {total}",
  first: "Primera",
  firstSr: "Primera página",
  prev: "Anterior",
  prevSr: "Página anterior",
  next: "Siguiente",
  nextSr: "Página siguiente",
  last: "Última",
  lastSr: "Última página",
};
const JA = {
  ...EN,
  range: "{total} 件中 {from}–{to}",
  first: "最初",
  firstSr: "最初のページ",
  prev: "前へ",
  prevSr: "前のページ",
  next: "次へ",
  nextSr: "次のページ",
  last: "最後",
  lastSr: "最後のページ",
};

const href = (page: number, pages: number) => (t: unknown) => {
  let p = page;
  if (t === "first") p = 1;
  else if (t === "prev") p = page - 1;
  else if (t === "next") p = page + 1;
  else if (t === "last") p = pages;
  else if (t && typeof t === "object" && "page" in t)
    p = (t as { page: number }).page;
  else if (t && typeof t === "object" && "per" in t)
    return `/list?per=${(t as { per: number }).per}#list`;
  return `/list?state=open${p > 1 ? `&page=${p}` : ""}#list`;
};

const LRI = "⁦";
const PDI = "⁩";
const plain = (s: string) => s.replace(/[⁦⁩]/g, "");

const ends = (html: string) =>
  [...html.matchAll(/<a\b[^>]*data-den-pager-go="(\w+)"[^>]*>(.*?)<\/a>/g)].map(
    (m) => {
      const tag = m[0].slice(0, m[0].indexOf(">") + 1);
      const at = (n: string) => tag.match(new RegExp(` ${n}="([^"]*)"`))?.[1];
      return {
        dir: m[1],
        label: at("aria-label"),
        title: at("title"),
        off: at("aria-disabled") === "true",
        href: at("href") ?? null,
        role: at("role") ?? null,
        inner: m[2]!,
      };
    },
  );
const range = (html: string) =>
  html.match(/class="den-pager-range"[^>]*>([^<]*)</)?.[1] ?? null;

describe("pagerHtml: pages with a total", () => {
  const html = pagerHtml({
    from: 101,
    to: 150,
    total: 809,
    per: 50,
    page: 3,
    href: href(3, 17),
    words: EN,
  });

  it("draws the range with its number run isolated", () => {
    expect(range(html)).toBe(`${LRI}101–150${PDI} of 809`);
  });

  it("draws the four ends as icon buttons with no visible word", () => {
    const e = ends(html);
    expect(e.map((x) => x.dir)).toEqual(["first", "prev", "next", "last"]);
    for (const x of e) {
      expect(x.inner).toMatch(
        /^<svg class="den-pager-ico"[^>]*aria-hidden="true"/,
      );
      expect(x.inner).toContain('width="16" height="16"');
      expect(x.inner).toContain('stroke="currentColor"');
      expect(x.inner.replace(/<[^>]*>/g, "").trim()).toBe("");
    }
    expect(html).not.toMatch(/[«‹›»]/);
    expect(html).not.toContain("den-pager-word");
  });

  it("names each end with its *Sr word and gives the word as a tooltip", () => {
    expect(ends(html).map((x) => [x.label, x.title])).toEqual([
      ["First page", "First"],
      ["Previous page", "Previous"],
      ["Next page", "Next"],
      ["Last page", "Last"],
    ]);
  });

  it("falls back to the word when there is no *Sr word", () => {
    const h = pagerHtml({
      from: 101,
      to: 150,
      total: 809,
      per: 50,
      page: 3,
      href: href(3, 17),
      words: { ...EN, nextSr: undefined },
    });
    const next = ends(h).find((x) => x.dir === "next")!;
    expect([next.label, next.title]).toEqual(["Next", "Next"]);
  });

  it("links each end, with rel on Previous and Next", () => {
    expect(ends(html).map((x) => x.href)).toEqual([
      "/list?state=open#list",
      "/list?state=open&amp;page=2#list",
      "/list?state=open&amp;page=4#list",
      "/list?state=open&amp;page=17#list",
    ]);
    expect(html).toMatch(/data-den-pager-go="prev"[^>]* rel="prev"/);
    expect(html).toMatch(/data-den-pager-go="next"[^>]* rel="next"/);
  });

  it("has a page picker of every page and a per-page choice", () => {
    const wide = html.match(/den-pager-wide[\s\S]*?<\/form>/)![0];
    expect(wide.match(/<option /g)).toHaveLength(17);
    expect(wide).toMatch(/<option value="3"[^>]* selected>3</);
    expect(plain(html)).toMatch(/<option value="3"[^>]* selected>3 \/ 17</);
    expect(html).toMatch(/data-den-pager-pick="per"/);
    const per = html.match(/den-pager-per[\s\S]*?<\/form>/)![0];
    expect(
      [...per.matchAll(/<option value="(\d+)"/g)].map((m) => m[1]),
    ).toEqual(["25", "50", "100", "200"]);
  });

  it("keeps the first two ends off on page 1, as links with no href", () => {
    const h = pagerHtml({
      from: 1,
      to: 50,
      total: 809,
      per: 50,
      page: 1,
      href: href(1, 17),
      words: EN,
    });
    const e = ends(h);
    expect(e.map((x) => x.off)).toEqual([true, true, false, false]);
    for (const x of e.filter((y) => y.off)) {
      expect(x.href).toBeNull();
      expect(x.role).toBe("link");
    }
  });

  it("keeps the last two ends off on the last page", () => {
    const h = pagerHtml({
      from: 801,
      to: 809,
      total: 809,
      per: 50,
      page: 17,
      href: href(17, 17),
      words: EN,
    });
    expect(ends(h).map((x) => x.off)).toEqual([false, false, true, true]);
  });

  it("uses a number field with Go over 500 pages", () => {
    const h = pagerHtml({
      from: 501,
      to: 525,
      total: 30000,
      per: 25,
      page: 21,
      href: href(21, 1200),
      words: EN,
    });
    expect(h).toMatch(
      /<input class="den-pager-sel den-pager-num" type="number"[^>]* max="1200" value="21"/,
    );
    expect(h).toContain("den-pager-go-num");
  });

  it("draws the es and ja words", () => {
    for (const [words, lang, want] of [
      [ES, "es", ["Primera página", "Primera"]],
      [JA, "ja", ["最初のページ", "最初"]],
    ] as const) {
      const h = pagerHtml({
        from: 51,
        to: 100,
        total: 1809,
        per: 50,
        page: 2,
        href: href(2, 37),
        words,
        lang,
      });
      const first = ends(h)[0]!;
      expect([first.label, first.title]).toEqual(want);
    }
  });

  it("escapes the host's words", () => {
    const h = pagerHtml({
      from: 101,
      to: 150,
      total: 809,
      per: 50,
      page: 3,
      href: href(3, 17),
      words: { ...EN, next: '<b>"x"', nextSr: "<i>" },
    });
    const next = ends(h).find((x) => x.dir === "next")!;
    expect(next.title).toBe("&lt;b&gt;&quot;x&quot;");
    expect(next.label).toBe("&lt;i&gt;");
  });
});

describe("pagerHtml: no total (a cursor list)", () => {
  it("has Previous and Next, First from page 2, no Last or picker", () => {
    const p1 = pagerHtml({
      from: 1,
      to: 50,
      hasNext: true,
      per: 50,
      href: href(1, 0),
      words: EN,
    });
    expect(ends(p1).map((x) => x.dir)).toEqual(["prev", "next"]);
    const p2 = pagerHtml({
      from: 51,
      to: 100,
      hasNext: true,
      per: 50,
      page: 2,
      href: href(2, 0),
      words: EN,
    });
    expect(ends(p2).map((x) => x.dir)).toEqual(["first", "prev", "next"]);
    expect(p2).not.toContain('data-den-pager-pick="page"');
    expect(range(p2)).toBe(`${LRI}51–100${PDI}`);
  });
});

describe("pagerHtml: one page", () => {
  const one = {
    from: 1,
    to: 40,
    total: 40,
    page: 1,
    href: href(1, 1),
    words: EN,
  };

  it("draws nothing at the default size", () => {
    expect(pagerHtml({ ...one, per: 50 })).toBe("");
    expect(pagerHtml({ ...one, per: 50, perDefault: 50 })).toBe("");
  });

  it("keeps the row when the person chose another size, so they can go back", () => {
    const h = pagerHtml({ ...one, per: 100, perDefault: 50 });
    expect(h).toContain('data-den-pager-pick="per"');
    expect(h).toMatch(/<option value="100"[^>]* selected>/);
    expect(ends(h).every((x) => x.off)).toBe(true);
  });

  it("draws nothing for an empty list", () => {
    expect(
      pagerHtml({ ...one, total: 0, to: 0, per: 100, perDefault: 50 }),
    ).toBe("");
  });
});

describe("pagerHtml: compact", () => {
  const base = {
    compact: true,
    from: 6,
    to: 10,
    total: 125,
    per: 5,
    page: 2,
    href: href(2, 25),
    words: EN,
  };

  it("draws the ends, a page field and the page count, nothing else", () => {
    const h = pagerHtml(base);
    expect(h).toContain('data-den-pager-size="compact"');
    expect(ends(h).map((x) => x.dir)).toEqual([
      "first",
      "prev",
      "next",
      "last",
    ]);
    expect(h).toMatch(
      /<input class="den-pager-sel den-pager-num" type="number"[^>]* min="1" max="25" value="2" aria-label="Page 2 of 25">/,
    );
    expect(h).toContain(`${LRI}/ 25${PDI}`);
    expect(h).not.toContain("den-pager-range");
    expect(h).not.toContain("den-pager-opts");
    expect(h).not.toContain('data-den-pager-pick="per"');
  });

  it("keeps the same names and tooltips as the full row", () => {
    expect(ends(pagerHtml(base)).map((x) => x.title)).toEqual([
      "First",
      "Previous",
      "Next",
      "Last",
    ]);
  });

  it("has no First or Last with no total", () => {
    const h = pagerHtml({ ...base, total: null, hasNext: true });
    expect(ends(h).map((x) => x.dir)).toEqual(["prev", "next"]);
  });
});

describe("pagerHtml: more mode", () => {
  it("says Show {n} more, then the last chunk, then All N shown", () => {
    const a = pagerHtml({
      mode: "more",
      from: 1,
      to: 50,
      total: 809,
      moreHref: "?page=2",
      words: EN,
    });
    expect(a).toMatch(/den-pager-more" href="\?page=2">Show 50 more</);
    const b = pagerHtml({
      mode: "more",
      from: 1,
      to: 780,
      total: 809,
      step: 50,
      moreHref: "?page=17",
      words: EN,
    });
    expect(b).toMatch(/>Show the last 29</);
    const c = pagerHtml({
      mode: "more",
      from: 1,
      to: 70,
      total: 70,
      loaded: true,
      words: EN,
    });
    expect(range(c)).toBe("All 70 shown");
    expect(c).not.toContain("den-pager-more");
  });
});

describe("cursorHref and cursorStart", () => {
  const url = "/list?state=open&per=50#list";

  it("goes forward with a trail and an offset, and back along it", () => {
    const n1 = cursorHref(url, "next", "c2");
    expect(n1).toBe("/list?state=open&per=50&after=c2&back=-&o=50#list");
    expect(cursorStart(n1)).toBe(50);
    const n2 = cursorHref(n1, "next", "c3");
    expect(n2).toBe("/list?state=open&per=50&after=c3&back=-.c2&o=100#list");
    const b1 = cursorHref(n2, "prev", null);
    expect(b1).toBe("/list?state=open&per=50&after=c2&back=-&o=50#list");
    expect(cursorHref(b1, "prev", null)).toBe("/list?state=open&per=50#list");
  });

  it("has no Previous on the first page and no Next without a cursor", () => {
    expect(cursorHref(url, "prev", null)).toBe("");
    expect(cursorHref(url, "next", null)).toBe("");
  });

  it("keeps the last 20 cursors, and Previous stops at the oldest kept", () => {
    let u = url;
    for (let i = 1; i <= 25; i++) u = cursorHref(u, "next", `c${i}`);
    const back = new URL(u, "http://h/").searchParams.get("back")!.split(".");
    expect(back[0]).toBe("~");
    expect(back.length - 1).toBe(20);
    expect(cursorStart(u)).toBe(25 * 50);
    for (let i = 0; i < 20; i++) u = cursorHref(u, "prev", null);
    expect(u).not.toBe("");
    expect(cursorHref(u, "prev", null)).toBe("");
  });

  it("goes to the start for First and for a new page size", () => {
    const n = cursorHref(cursorHref(url, "next", "c2"), "next", "c3");
    expect(cursorHref(n, "first", null)).toBe("/list?state=open&per=50#list");
    expect(cursorHref(n, { per: 100 }, null)).toBe(
      "/list?state=open&per=100#list",
    );
    expect(cursorStart(url)).toBe(0);
  });
});
