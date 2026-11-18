/**
 * The header's appearance UI (public/appearance.js), on a small fake DOM:
 * the theme's mark (and that a live switch redraws it), the user menu's
 * model (R10, dev.20: Appearance, Theme with "Org default", Language,
 * Restart Den…, All settings), handed to the UI kit's ◐ ▾ (den-ui 0.7.0:
 * the kit draws the button and the menu and gives Den the pick), and the
 * same choices as ⌘K palette commands (R17).
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import {
  appearanceMenu,
  appearancePick,
  initAppearance,
  markView,
  themeNotice,
  themeOptions,
} from "../../../src/ui/server/public/appearance.js";
import { markHtml } from "../../../packages/den-ui/src/shell-html.js";

// ── A fake DOM: just what appearance.js touches ──────────────────────────────

type Listener = (e: FakeEvent) => unknown;
interface FakeEvent {
  key?: string;
  target?: El;
  stopPropagation: () => void;
}

class El {
  tagName: string;
  id = "";
  className = "";
  title = "";
  hidden = false;
  type = "";
  src = "";
  alt = "";
  rel = "";
  href = "";
  width = 0;
  height = 0;
  htmlFor = "";
  selected = false;
  dataset: Record<string, string> = {};
  children: El[] = [];
  parent: El | null = null;
  attrs: Record<string, string> = {};
  listeners: Record<string, Listener[]> = {};
  private text = "";
  private val = "";
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(tag: string) {
    this.tagName = tag.toUpperCase();
  }
  get textContent(): string {
    return this.text + this.children.map((c) => c.textContent).join("");
  }
  set textContent(v: string) {
    this.children = [];
    this.text = v;
  }
  get value(): string {
    if (this.tagName === "SELECT")
      return (this.children.find((o) => o.selected) ?? this.children[0])?.val;
    return this.val;
  }
  set value(v: string) {
    if (this.tagName === "SELECT")
      for (const o of this.children) o.selected = o.val === v;
    else this.val = v;
  }
  setAttribute(k: string, v: string) {
    this.attrs[k] = String(v);
    // The properties a few attributes reflect.
    if (k === "class") this.className = String(v);
    else if (k === "title" || k === "src" || k === "alt" || k === "id")
      this[k] = String(v);
    else if (k === "width" || k === "height") this[k] = Number(v);
  }
  get attributes(): { name: string; value: string }[] {
    return Object.entries(this.attrs).map(([name, value]) => ({
      name,
      value,
    }));
  }
  get childNodes(): El[] {
    return [...this.children];
  }
  /** A <template>'s content: its parsed children. */
  get content(): { firstElementChild: El | null } {
    return { firstElementChild: this.children[0] ?? null };
  }
  /** Markup as the kit's markHtml writes it: elements and attributes. */
  set innerHTML(html: string) {
    this.replaceChildren();
    const stack: El[] = [this];
    for (const m of html.matchAll(/<(\/?)([a-z]+)([^>]*)>/g)) {
      if (m[1]) {
        stack.pop();
        continue;
      }
      const el = new El(m[2]!);
      for (const a of m[3]!.matchAll(/([a-z-]+)="([^"]*)"/g))
        el.setAttribute(a[1]!, a[2]!);
      stack[stack.length - 1]!.appendChild(el);
      if (m[2] !== "img") stack.push(el);
    }
  }
  getAttribute(k: string) {
    return this.attrs[k] ?? null;
  }
  appendChild(c: El) {
    c.remove();
    c.parent = this;
    this.children.push(c);
    return c;
  }
  append(...cs: El[]) {
    for (const c of cs) this.appendChild(c);
  }
  replaceChildren(...cs: El[]) {
    for (const c of this.children) c.parent = null;
    this.children = [];
    this.text = "";
    this.append(...cs);
  }
  after(c: El) {
    if (!this.parent) return;
    c.remove();
    const sib = this.parent.children;
    sib.splice(sib.indexOf(this) + 1, 0, c);
    c.parent = this.parent;
  }
  remove() {
    if (!this.parent) return;
    const sib = this.parent.children;
    sib.splice(sib.indexOf(this), 1);
    this.parent = null;
  }
  contains(o: El | undefined): boolean {
    for (let x: El | null = o ?? null; x; x = x.parent)
      if (x === this) return true;
    return false;
  }
  addEventListener(t: string, f: Listener) {
    (this.listeners[t] ??= []).push(f);
  }
  async fire(t: string, e: Partial<FakeEvent> = {}) {
    const ev: FakeEvent = { target: this, stopPropagation: () => {}, ...e };
    await Promise.all((this.listeners[t] ?? []).map((f) => f(ev)));
  }
  focus() {
    doc.activeElement = this;
  }
  *walk(): Generator<El> {
    yield this;
    for (const c of this.children) yield* c.walk();
  }
}

const html = new El("html");
const head = html.appendChild(new El("head"));
const body = html.appendChild(new El("body"));
const doc = {
  documentElement: html,
  head,
  body,
  activeElement: null as El | null,
  listeners: {} as Record<string, Listener[]>,
  createElement: (t: string) => new El(t),
  getElementById: (id: string) => {
    for (const e of html.walk()) if (e.id === id) return e;
    return null;
  },
  querySelector: (sel: string) => {
    for (const e of html.walk())
      if (sel === "header" ? e.tagName === "HEADER" : false) return e;
    return null;
  },
  addEventListener(t: string, f: Listener) {
    (this.listeners[t] ??= []).push(f);
  },
  async fire(t: string, e: Partial<FakeEvent>) {
    const ev: FakeEvent = { stopPropagation: () => {}, ...e };
    await Promise.all((this.listeners[t] ?? []).map((f) => f(ev)));
  },
};

// ── A fake server ────────────────────────────────────────────────────────────

const MARKS = {
  sun: { svg: "/theme/sun/mark.svg", svg_dark: "/theme/sun/mark-dark.svg" },
  ink: { text: "Ik", shape: "circle" },
};
const server = {
  /** When set, /api/themes reports this as the stored choice (an invalid one). */
  stored: null as string | null,
  theme: null as string | null,
  mode: "dark",
  posts: [] as unknown[],
};
const themesPayload = () => {
  const id = server.theme ?? "sun";
  return {
    org_default: { id: "sun", name: "Sun" },
    active: {
      id,
      name: id === "sun" ? "Sun" : "Ink",
      default_mode: "dark",
      mark: MARKS[id as keyof typeof MARKS],
    },
    prefs: { theme: server.stored ?? server.theme, mode: server.mode },
    themes: [
      { id: "den", name: "Den", ok: true },
      { id: "ink", name: "Ink", ok: true },
      { id: "sun", name: "Sun", ok: true },
      {
        id: "bad",
        name: "Bad",
        ok: false,
        problem: "/author: no author; dark: a on b is 2, needs 4.5",
      },
    ],
  };
};
const fakeFetch = async (url: string, init?: { body?: string }) => {
  if (url === "/api/themes")
    return { ok: true, json: async () => themesPayload() };
  if (url === "/api/settings") {
    const a = (JSON.parse(init?.body ?? "{}") as { appearance: never })
      .appearance as { theme?: string | null; mode?: string };
    server.posts.push(a);
    // The server stores what you picked: null for Org default, else the id
    // (the org's own theme too: a pin).
    if ("theme" in a) server.theme = a.theme || null;
    if (a.mode) server.mode = a.mode;
    return { ok: true, json: async () => ({ ok: true }), text: async () => "" };
  }
  throw new Error(`unexpected fetch ${url}`);
};

const g = globalThis as Record<string, unknown>;
const saved = { document: g.document, window: g.window, fetch: g.fetch };
let header: El;
let mark: El;

/** The shell's side (shell.js): openMenu and the COMMANDS registry. */
interface MenuItem {
  heading?: string;
  hr?: boolean;
  note?: string;
  slot?: string;
  hidden?: boolean;
  label?: string;
  checked?: boolean;
  href?: string;
  onSelect?: () => unknown;
}
interface Cmd {
  id: string;
  label: string;
  keywords: string[];
  kind: string;
  run: () => unknown;
}
/** What the kit's hydrateAppearance was handed (den-ui 0.7.0). */
interface KitMenu {
  mode: string;
  modes: { value: string; label: string }[];
  themes: { value: string; label: string; selected?: boolean }[];
  notice: string | null;
  languages: { id: string; name: string; current?: boolean }[];
  items: { label: string; href?: string; id?: string }[];
}
const hooked: {
  btn: El;
  opts: {
    menu: () => KitMenu;
    onPick: (kind: string, value: string | null) => unknown;
  };
}[] = [];
const cmds = new Map<string, Cmd>();
const languagePicks: string[] = [];
const denShell = {
  registerCommand: (c: Cmd) => cmds.set(c.id, c),
  unregisterCommand: (id: string) => cmds.delete(id),
  commands: () => [...cmds.values()],
  // The shell's language (R19, dev.39): a pick goes to setLanguage.
  lang: () => "en",
  languages: () => [
    { id: "en", name: "English" },
    { id: "ja", name: "日本語" },
  ],
  setLanguage: (id: string) => languagePicks.push(id),
};

beforeAll(async () => {
  const link = head.appendChild(new El("link"));
  link.id = "theme-css";
  header = body.appendChild(new El("header"));
  mark = header.appendChild(new El("span"));
  mark.id = "den-mark";
  header.appendChild(new El("nav"));
  // ◐ ▾ as the kit draws it in the bar's account slot.
  const um = header.appendChild(new El("button"));
  um.id = "appearance-btn";
  g.document = doc;
  g.window = {
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    denShell,
    DenUIShell: {
      markHtml,
      hydrateAppearance: (btn: El, opts: (typeof hooked)[number]["opts"]) =>
        hooked.push({ btn, opts }),
    },
  };
  g.fetch = fakeFetch;
  await initAppearance();
});
afterAll(() => Object.assign(g, saved));

const img = () => mark.children.find((c) => c.tagName === "IMG");

describe("markView", () => {
  it("is the SVG, the dark variant in dark mode when there is one", () => {
    expect(markView({ svg: "/a.svg" }, "dark", "A")).toEqual({
      kind: "svg",
      src: "/a.svg",
    });
    expect(markView({ svg: "/a.svg", svg_dark: "/d.svg" }, "dark")).toEqual({
      kind: "svg",
      src: "/d.svg",
    });
    expect(markView({ svg: "/a.svg", svg_dark: "/d.svg" }, "light")).toEqual({
      kind: "svg",
      src: "/a.svg",
    });
  });
  it("is text in the mark's shape, else the theme's initial", () => {
    expect(markView({ text: "MO", shape: "square" }, "dark")).toEqual({
      kind: "text",
      text: "MO",
      shape: "square",
    });
    expect(markView(null, "light", "Paper")).toEqual({
      kind: "text",
      text: "P",
      shape: "rounded",
    });
  });
});

describe("themeOptions", () => {
  const themes = [
    { id: "den", name: "Den", ok: true },
    { id: "paper", name: "Paper", ok: true },
    { id: "bad", name: "Bad", ok: false },
  ];
  it("starts with Org default (<name>), selected when you chose nothing", () => {
    expect(themeOptions(themes, null, { id: "paper", name: "Paper" })).toEqual([
      { value: "", label: "Org default (Paper)", selected: true },
      { value: "den", label: "Den", selected: false },
      { value: "paper", label: "Paper", selected: false },
    ]);
    expect(themeOptions(themes, "den", null)[0]).toEqual({
      value: "",
      label: "Org default (Den)",
      selected: false,
    });
    expect(
      themeOptions(themes, "den", null).find((o) => o.selected)?.value,
    ).toBe("den");
  });
  it("a named theme equal to the org default is selected and reads (pinned)", () => {
    const org = { id: "paper", name: "Paper" };
    expect(themeOptions(themes, "paper", org)).toEqual([
      { value: "", label: "Org default (Paper)", selected: false },
      { value: "den", label: "Den", selected: false },
      { value: "paper", label: "Paper (pinned)", selected: true },
    ]);
    // Pinned only when it is both your choice and the org's default.
    expect(themeOptions(themes, "den", org).map((o) => o.label)).toEqual([
      "Org default (Paper)",
      "Den",
      "Paper",
    ]);
  });
  it("never offers a theme that fails validate, even your stored choice", () => {
    const opts = themeOptions(themes, "bad", { id: "paper", name: "Paper" });
    expect(opts.map((o) => o.value)).toEqual(["", "den", "paper"]);
    // Nothing is selected: an invalid choice must not read as Org default.
    expect(opts.some((o) => o.selected)).toBe(false);
  });

  it("says why your stored theme isn't in use, and what is", () => {
    const withProblem = [
      ...themes.filter((t) => t.id !== "bad"),
      {
        id: "bad",
        name: "Bad",
        ok: false,
        problem: "/author: no author; light: x on y is 2.1, needs 4.5",
      },
    ];
    expect(
      themeNotice(withProblem, "bad", { id: "paper", name: "Paper" }),
    ).toBe(
      "Your theme bad isn't valid (/author: no author), so Paper is in use",
    );
    expect(themeNotice(withProblem, "gone", { id: "den", name: "Den" })).toBe(
      "Your theme gone isn't installed, so Den is in use",
    );
    expect(themeNotice(withProblem, "paper", null)).toBeNull();
    expect(themeNotice(withProblem, null, null)).toBeNull();
  });
});

/**
 * The kit's menu as rows, in the kit's order (appearanceMenuHtml): each
 * part under its heading, a rule between parts; a row's onSelect is the
 * pick the kit would send.
 */
function asItems(m: KitMenu): MenuItem[] {
  const pick = (kind: string, value: string | null) => () =>
    appearancePick(kind, value);
  const parts: MenuItem[][] = [
    [
      { heading: "Appearance" },
      ...m.modes.map((x) => ({
        label: x.label,
        checked: x.value === m.mode,
        onSelect: pick("mode", x.value),
      })),
    ],
  ];
  if (m.themes.length || m.notice)
    parts.push([
      { heading: "Theme" },
      ...m.themes.map((x) => ({
        label: x.label,
        checked: !!x.selected,
        onSelect: pick("theme", x.value),
      })),
      ...(m.notice ? [{ note: m.notice }] : []),
    ]);
  if (m.languages.length)
    parts.push([
      { heading: "Language" },
      ...m.languages.map((x) => ({
        label: x.name,
        checked: !!x.current,
        onSelect: pick("language", x.id),
      })),
    ]);
  parts.push(
    m.items.map((x) => ({
      label: x.label,
      href: x.href,
      onSelect: pick("item", x.id ?? null),
    })),
  );
  return parts.flatMap((p, i) => (i ? [{ hr: true }, ...p] : p));
}
const items = () => asItems(appearanceMenu() as KitMenu);
const row = (label: string) => items().find((i) => i.label === label)!;
const checked = (from: string) => {
  const all = items();
  const start = all.findIndex((i) => i.heading === from);
  const end = all.findIndex((i, n) => n > start && (i.hr || i.heading));
  return all
    .slice(start + 1, end < 0 ? undefined : end)
    .filter((i) => i.checked)
    .map((i) => i.label);
};

describe("the user menu (initAppearance, R10)", () => {
  it("issue 81: My reports is in it while reports are on, and opens them", () => {
    const sh = denShell as typeof denShell & {
      reportButton?: () => string;
      myReports?: () => void;
    };
    const ids = () =>
      (appearanceMenu() as KitMenu).items.map((i) => i.id ?? i.href);
    let opened = 0;
    try {
      sh.reportButton = () => "<button data-den-report></button>";
      sh.myReports = () => void opened++;
      expect(ids()).toEqual(["my-reports", "restart", "/settings#appearance"]);
      appearancePick("item", "my-reports");
      expect(opened).toBe(1);
      // Reports off: no Report button, and no My reports.
      sh.reportButton = () => "";
      expect(ids()).toEqual(["restart", "/settings#appearance"]);
    } finally {
      delete sh.reportButton;
      delete sh.myReports;
    }
  });

  it("draws the active theme's mark, not the favicon", () => {
    expect(img()?.src).toBe("/theme/sun/mark-dark.svg"); // dark mode
    expect(img()?.alt).toBe("");
  });

  it("hands the kit's ◐ ▾ its menu once: Appearance, Theme, Language, Restart, All settings", async () => {
    // The kit draws ◐ ▾ (den-ui 0.7.0); Den wires it once, and only it.
    const btn = header.children.at(-1)!;
    expect(hooked).toHaveLength(1);
    expect(hooked[0]!.btn).toBe(btn);
    expect(btn.dataset.wired).toBe("1");
    await initAppearance();
    expect(hooked).toHaveLength(1);
    const menu = asItems(hooked[0]!.opts.menu());
    expect(
      menu.map((i) =>
        i.heading
          ? `# ${i.heading}`
          : i.hr
            ? "--"
            : i.slot
              ? `[${i.slot}${i.hidden ? " hidden" : ""}]`
              : `${i.label}${i.checked ? " ✓" : ""}${i.href ? ` → ${i.href}` : ""}`,
      ),
    ).toEqual([
      "# Appearance",
      "System",
      "Dark ✓",
      "Light",
      "--",
      "# Theme",
      "Org default (Sun) ✓",
      "Den",
      "Ink",
      "Sun",
      "--",
      // Language (R19, dev.39): each named in itself.
      "# Language",
      "English ✓",
      "日本語",
      "--",
      // D64: Restart Den, always here.
      "Restart Den…",
      // The Settings page (R21), at Appearance.
      "All settings → /settings#appearance",
    ]);
  });

  it("redraws the mark on a mode switch and a live theme switch", async () => {
    await row("Light").onSelect!();
    expect(html.dataset.mode).toBe("light");
    expect(server.posts.at(-1)).toEqual({ mode: "light" });
    expect(checked("Appearance")).toEqual(["Light"]);
    expect(img()?.src).toBe("/theme/sun/mark.svg");

    await row("Ink").onSelect!();
    expect(server.posts.at(-1)).toEqual({ theme: "ink" });
    expect(img()).toBeUndefined();
    expect(mark.textContent).toBe("Ik");
    expect(mark.className).toContain("den-mark-circle");
    // The stylesheet is swapped for the new theme's.
    expect(head.children.filter((c) => c.tagName === "LINK")).toHaveLength(2);
    expect(checked("Theme")).toEqual(["Ink"]);
  });

  it("an invalid stored theme checks nothing and says what is in use", async () => {
    expect(items().some((i) => i.note)).toBe(false);
    server.stored = "bad";
    await row("Den").onSelect!();
    expect(checked("Theme")).toEqual([]);
    expect(items().map((i) => i.label)).not.toContain("Bad");
    expect(items().find((i) => i.note)?.note).toBe(
      "Your theme bad isn't valid (/author: no author), so Ink is in use",
    );
    // Picking any theme replaces the stored choice, as usual.
    server.stored = null;
    await row("Ink").onSelect!();
    expect(server.posts.at(-1)).toEqual({ theme: "ink" });
    expect(items().some((i) => i.note)).toBe(false);
    expect(checked("Theme")).toEqual(["Ink"]);
  });

  it("Org default writes theme null; the org's theme by name is a pin", async () => {
    await row("Org default (Sun)").onSelect!();
    expect(server.posts.at(-1)).toEqual({ theme: null });
    expect(checked("Theme")).toEqual(["Org default (Sun)"]);
    expect(img()?.src).toBe("/theme/sun/mark.svg");
    // Picking the org's own theme by name pins it: that theme is checked,
    // not Org default, and it says so.
    await row("Sun").onSelect!();
    expect(server.posts.at(-1)).toEqual({ theme: "sun" });
    expect(checked("Theme")).toEqual(["Sun (pinned)"]);
    // Back to following the org.
    await row("Org default (Sun)").onSelect!();
    expect(checked("Theme")).toEqual(["Org default (Sun)"]);
    expect(items().find((i) => i.label?.startsWith("Sun"))?.label).toBe("Sun");
  });

  it("offers the same choices as ⌘K palette commands, which switch live", async () => {
    expect([...cmds.values()].map((c) => [c.id, c.label, c.kind])).toEqual([
      ["appearance-system", "Appearance: System", "action"],
      ["appearance-dark", "Appearance: Dark", "action"],
      ["appearance-light", "Appearance: Light", "action"],
      ["theme-org-default", "Theme: Org default (Sun)", "action"],
      ["theme-den", "Theme: Den", "action"],
      ["theme-ink", "Theme: Ink", "action"],
      ["theme-sun", "Theme: Sun", "action"],
      ["language-en", "Language: English", "action"],
      ["language-ja", "Language: 日本語", "action"],
    ]);
    await cmds.get("language-ja")!.run();
    expect(languagePicks).toEqual(["ja"]);
    expect(cmds.get("appearance-dark")!.keywords).toContain("mode");
    await cmds.get("appearance-dark")!.run();
    expect(server.posts.at(-1)).toEqual({ mode: "dark" });
    expect(html.dataset.mode).toBe("dark");
    await cmds.get("theme-ink")!.run();
    expect(server.posts.at(-1)).toEqual({ theme: "ink" });
    expect(mark.textContent).toBe("Ik");
    // Only appearance writes: nothing else was posted.
    expect(
      server.posts.every((p) =>
        Object.keys(p as object).every((k) => k === "mode" || k === "theme"),
      ),
    ).toBe(true);
  });
});

describe("pages", () => {
  const PUBLIC = path.join(process.cwd(), "src", "ui", "server", "public");
  it.each(fs.readdirSync(PUBLIC).filter((f) => f.endsWith(".html")))(
    "%s has the shell's mark slot and no favicon image in the header",
    (f) => {
      const page = fs.readFileSync(path.join(PUBLIC, f), "utf-8");
      // The mark slot is the shell's (shell.js, drawn by the UI kit's
      // shell-html.js since issue 95), on every page.
      expect(page).toContain('<script src="/shell.js"></script>');
      expect(
        fs.readFileSync(
          path.join(
            process.cwd(),
            "packages",
            "den-ui",
            "src",
            "shell-html.js",
          ),
          "utf-8",
        ),
      ).toMatch(/<span class="den-mark" id="den-mark"/);
      expect(page).not.toMatch(/<img[^>]*src="\/favicon\.ico"/);
    },
  );
});
