/**
 * The den-ui toast, the checks that need no browser.
 *
 *   - timing (toastClock, fake timers): 3 s plain, 10 s with Undo, a host's
 *     ms; hover, focus and a hidden page hold it, and when the last ends it
 *     starts again from a full 3 s; after Undo, 3 s; an error never ends
 *     by its timer;
 *   - the markup (toastHtml): the region's role (status, or alert for an
 *     error), the host's words escaped, Undo as a POST form (fields
 *     escaped, any other method refused) or a button, the link, Close on
 *     an error;
 *   - the kit's words in en, es and ja (Hub's today).
 *
 * The DOM half (one live region reused, focus never taken and given back,
 * Esc, Undo once, a new toast dropping the old Undo, the look, reduced
 * motion) is toast-559.browser.test.ts.
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import {
  PLAIN_MS,
  UNDO_MS,
  toastClock,
  toastHtml,
} from "../../../packages/den-ui/src/toast.js";
import { en, es, ja } from "../../../packages/den-ui/src/strings.js";
import * as fs from "fs";
import * as path from "path";

describe("issue 559: the toast's timing", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  const clock = (o: Parameters<typeof toastClock>[0] = {}) => {
    let ended = 0;
    const c = toastClock({ ...o, onExpire: () => ended++ });
    return { c, ended: () => ended };
  };

  it("the kit's times: 3 s plain, 10 s with Undo (today's Undo time, kept)", () => {
    expect([PLAIN_MS, UNDO_MS]).toEqual([3000, 10_000]);
    const p = clock();
    p.c.start();
    jest.advanceTimersByTime(2999);
    expect(p.ended()).toBe(0);
    jest.advanceTimersByTime(1);
    expect(p.ended()).toBe(1);
    const u = clock({ undo: true });
    u.c.start();
    jest.advanceTimersByTime(9999);
    expect(u.ended()).toBe(0);
    jest.advanceTimersByTime(1);
    expect(u.ended()).toBe(1);
  });

  it("a host's ms wins", () => {
    const h = clock({ ms: 500, undo: true });
    h.c.start();
    jest.advanceTimersByTime(500);
    expect(h.ended()).toBe(1);
  });

  it("hover, focus and a hidden page hold it; the last release starts a full 3 s", () => {
    const h = clock({ undo: true });
    h.c.start();
    jest.advanceTimersByTime(7000);
    h.c.hold("hover");
    h.c.hold("focus");
    h.c.hold("hidden");
    jest.advanceTimersByTime(60_000);
    expect(h.ended()).toBe(0);
    h.c.release("hover");
    h.c.release("focus");
    jest.advanceTimersByTime(60_000);
    expect(h.ended()).toBe(0);
    h.c.release("hidden");
    // Not the 1 s left: a full plain time.
    jest.advanceTimersByTime(PLAIN_MS - 1);
    expect(h.ended()).toBe(0);
    jest.advanceTimersByTime(1);
    expect(h.ended()).toBe(1);
  });

  it("a release with nothing held changes nothing", () => {
    const h = clock();
    h.c.start();
    jest.advanceTimersByTime(2000);
    h.c.release("hover");
    jest.advanceTimersByTime(1000);
    expect(h.ended()).toBe(1);
  });

  it("after Undo, a plain time", () => {
    const h = clock({ undo: true });
    h.c.start();
    jest.advanceTimersByTime(1000);
    h.c.undone();
    jest.advanceTimersByTime(PLAIN_MS);
    expect(h.ended()).toBe(1);
  });

  it("an error never ends by its timer", () => {
    const e = clock({ kind: "error" });
    e.c.start();
    e.c.hold("hover");
    e.c.release("hover");
    jest.advanceTimersByTime(10 * 60_000);
    expect(e.ended()).toBe(0);
    expect(e.c.running()).toBe(false);
  });

  it("stop: it never ends after", () => {
    const h = clock();
    h.c.start();
    h.c.stop();
    jest.advanceTimersByTime(PLAIN_MS * 2);
    expect(h.ended()).toBe(0);
  });
});

describe("issue 559: the toast's markup", () => {
  const roleOf = (h: string) => /^<div[^>]*role="([^"]+)"/.exec(h)?.[1];

  it("a plain toast: a polite status region, the host's words escaped", () => {
    const h = toastHtml({ message: 'Saved <b>"x"</b>', lang: "en" });
    expect(roleOf(h)).toBe("status");
    expect(h).toContain('aria-live="polite"');
    expect(h).toContain("Saved &lt;b&gt;&quot;x&quot;&lt;/b&gt;");
    expect(h).not.toContain("data-toast-undo");
    expect(h).not.toContain("data-toast-close");
  });

  it("an error: an alert region, the kit's Close, the detail line", () => {
    const h = toastHtml({
      kind: "error",
      message: "Couldn't save",
      detail: "Request r-1",
      lang: "ja",
    });
    expect(roleOf(h)).toBe("alert");
    expect(h).toContain('data-kind="error"');
    expect(h).toMatch(/data-toast-close aria-label="閉じる"/);
    expect(h).toContain(
      '<span class="den-toast-detail" data-toast-detail>Request r-1</span>',
    );
  });

  it("Undo as a POST form that works with no script; fields escaped", () => {
    const h = toastHtml({
      message: "Removed",
      lang: "es",
      undo: {
        form: {
          action: "/g/undo?a=1&b=2",
          fields: { csrf: 't"<x>', removed: "7" },
        },
      },
    });
    expect(h).toContain(
      '<form class="den-toast-form" method="post" action="/g/undo?a=1&amp;b=2">',
    );
    expect(h).toContain('name="csrf" value="t&quot;&lt;x&gt;"');
    expect(h).toMatch(
      /<button type="submit" class="den-toast-undo" data-toast-undo>Deshacer<\/button>/,
    );
  });

  it("an Undo form is POST only", () => {
    for (const method of ["get", "GET", "put", ""])
      expect(() =>
        toastHtml({ message: "x", undo: { form: { action: "/u", method } } }),
      ).toThrow(/post/);
    expect(() =>
      toastHtml({
        message: "x",
        undo: { form: { action: "/u", method: "POST" } },
      }),
    ).not.toThrow();
  });

  it("Undo as a button, a link and the host's own actions", () => {
    const h = toastHtml({
      message: "Unpinned",
      undo: true,
      link: { href: "/pins", label: "Pins" },
      actions: [{ label: "Retry" }],
    } as Parameters<typeof toastHtml>[0]);
    expect(h).toMatch(
      /<button type="button" class="den-toast-undo" data-toast-undo>Undo<\/button>/,
    );
    expect(h).toContain(
      '<button type="button" class="den-toast-act" data-toast-act="0">Retry</button>',
    );
    expect(h).toContain(
      '<a class="den-toast-link" data-toast-link href="/pins">Pins</a>',
    );
  });
});

describe("issue 559: the toast's addresses", () => {
  it("a link is http(s), mailto or relative; any other is left out", () => {
    const link = (href: string) =>
      toastHtml({ message: "x", link: { href, label: "Open" } });
    for (const ok of [
      "/pins",
      "pins?a=1",
      "#x",
      "https://e.test/a",
      "mailto:a@e.test",
    ])
      expect(link(ok)).toContain("den-toast-link");
    for (const bad of [
      "javascript:alert(1)",
      " JavaScript:alert(1)",
      "data:text/html,x",
      "vbscript:x",
    ])
      expect(link(bad)).not.toContain("den-toast-link");
  });

  it("an Undo form's action is http(s) or relative; any other throws", () => {
    const form = (action: string) => () =>
      toastHtml({ message: "x", undo: { form: { action } } });
    expect(form("/g/undo")).not.toThrow();
    expect(form("https://e.test/undo")).not.toThrow();
    for (const bad of [
      "javascript:alert(1)",
      "data:text/html,x",
      "mailto:a@e.test",
    ])
      expect(form(bad)).toThrow(/action/);
  });
});

describe("issue 559: the toast's deadline (until)", () => {
  it("toastHtml carries until as data-until on the toast; none, no attribute", () => {
    expect(
      toastHtml({ message: "x", undo: true, until: 1764064805000 }),
    ).toContain('data-until="1764064805000"');
    expect(toastHtml({ message: "x" })).not.toContain("data-until");
    expect(toastHtml({ message: "x", until: Number.NaN })).not.toContain(
      "data-until",
    );
  });
});

describe("issue 559: the toast's words", () => {
  it("are Hub's today, in en, es and ja", () => {
    const w = (t: Record<string, string>) => [
      t["kit.toast.undo"],
      t["kit.toast.undone"],
      t["kit.toast.close"],
    ];
    expect(w(en)).toEqual(["Undo", "Undone.", "Close"]);
    expect(w(es)).toEqual(["Deshacer", "Deshecho.", "Cerrar"]);
    expect(w(ja)).toEqual(["元に戻す", "元に戻しました。", "閉じる"]);
  });
});

describe("issue 559: the toast's width", () => {
  it("is sized from its fixed box (%), never vw: 100vw counts a classic scrollbar", () => {
    const css = fs
      .readFileSync(
        path.join(__dirname, "../../../packages/den-ui/src/toast.css"),
        "utf-8",
      )
      .replace(/\/\*[\s\S]*?\*\//g, "");
    expect(css.match(/[\d.]+vw\b/g) ?? []).toEqual([]);
    expect(css).toContain("calc(100% - 32px)");
  });
});

describe("issue 559: Den's Undo time is today's", () => {
  it("the Agents page's Remove keeps its 10 s Undo", () => {
    // A browser module (no jest transform): read its source.
    const src = fs.readFileSync(
      path.join(process.cwd(), "src/ui/server/public/agents-page.js"),
      "utf-8",
    );
    expect(src).toMatch(/^export const UNDO_MS = 10_000;$/m);
  });
});
