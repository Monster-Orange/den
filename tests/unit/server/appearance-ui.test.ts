/**
 * The header's appearance UI (public/appearance.js), on a small fake DOM:
 * the theme's mark (and that a live switch redraws it), the Theme menu's
 * "Org default" entry, and the popover's accessibility (named controls,
 * aria-expanded/aria-controls, Escape closes and returns focus).
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import {
  initAppearance,
  markView,
  themeOptions,
} from "../../../src/ui/server/public/appearance.js";

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
    prefs: { theme: server.theme, mode: server.mode },
    themes: [
      { id: "den", name: "Den", ok: true },
      { id: "ink", name: "Ink", ok: true },
      { id: "sun", name: "Sun", ok: true },
      { id: "bad", name: "Bad", ok: false },
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
    // The server stores null for the org default (sun).
    if ("theme" in a) server.theme = a.theme === "sun" ? null : a.theme!;
    if (a.mode) server.mode = a.mode;
    return { ok: true, json: async () => ({ ok: true }), text: async () => "" };
  }
  throw new Error(`unexpected fetch ${url}`);
};

const g = globalThis as Record<string, unknown>;
const saved = { document: g.document, window: g.window, fetch: g.fetch };
let header: El;
let mark: El;

beforeAll(async () => {
  const link = head.appendChild(new El("link"));
  link.id = "theme-css";
  header = body.appendChild(new El("header"));
  mark = header.appendChild(new El("span"));
  mark.id = "den-mark";
  header.appendChild(new El("nav"));
  g.document = doc;
  g.window = { matchMedia: () => ({ matches: false, addEventListener() {} }) };
  g.fetch = fakeFetch;
  await initAppearance();
});
afterAll(() => Object.assign(g, saved));

const el = (id: string) => doc.getElementById(id)!;
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
});

describe("the header (initAppearance)", () => {
  it("draws the active theme's mark, not the favicon", () => {
    expect(img()?.src).toBe("/theme/sun/mark-dark.svg"); // dark mode
    expect(img()?.alt).toBe("");
  });

  it("redraws the mark on a mode switch and a live theme switch", async () => {
    const mode = el("appearance-mode");
    mode.value = "light";
    await mode.fire("change");
    expect(html.dataset.mode).toBe("light");
    expect(img()?.src).toBe("/theme/sun/mark.svg");

    const theme = el("appearance-theme");
    theme.value = "ink";
    await theme.fire("change");
    expect(server.posts.at(-1)).toEqual({ theme: "ink" });
    expect(img()).toBeUndefined();
    expect(mark.textContent).toBe("Ik");
    expect(mark.className).toContain("den-mark-circle");
    // The stylesheet is swapped for the new theme's.
    expect(head.children.filter((c) => c.tagName === "LINK")).toHaveLength(2);
  });

  it("Org default writes theme null and is selected again", async () => {
    const theme = el("appearance-theme");
    expect(theme.children[0].textContent).toBe("Org default (Sun)");
    expect(theme.value).toBe("ink");
    theme.value = "";
    await theme.fire("change");
    expect(server.posts.at(-1)).toEqual({ theme: null });
    expect(theme.value).toBe("");
    expect(img()?.src).toBe("/theme/sun/mark.svg");
    // Picking the org's own theme by name lands on Org default too.
    theme.value = "sun";
    await theme.fire("change");
    expect(server.posts.at(-1)).toEqual({ theme: "sun" });
    expect(theme.value).toBe("");
    expect(theme.children.map((o) => o.value)).toEqual([
      "",
      "den",
      "ink",
      "sun",
    ]);
  });

  it("names every control and wires the popover for assistive tech", () => {
    const btn = header.children
      .find((c) => c.id === "appearance")!
      .children.find((c) => c.tagName === "BUTTON")!;
    expect(btn.getAttribute("aria-label")).toBe("Appearance");
    expect(btn.getAttribute("aria-haspopup")).toBe("true");
    const pop = el(btn.getAttribute("aria-controls")!);
    expect(pop.className).toBe("appearance-pop");
    expect(pop.hidden).toBe(true);
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    const labels = [...pop.walk()].filter((e) => e.tagName === "LABEL");
    expect(labels.map((l) => [l.textContent, l.htmlFor])).toEqual([
      ["Mode", "appearance-mode"],
      ["Theme", "appearance-theme"],
    ]);
    expect(el("appearance-mode").getAttribute("aria-label")).toBe("Mode");
    expect(el("appearance-theme").getAttribute("aria-label")).toBe("Theme");
  });

  it("opens on click; Escape closes it and returns focus to the button", async () => {
    const box = el("appearance");
    const btn = box.children[0];
    const pop = el("appearance-pop");
    await btn.fire("click");
    expect(pop.hidden).toBe(false);
    expect(btn.getAttribute("aria-expanded")).toBe("true");
    el("appearance-theme").focus();
    await doc.fire("keydown", { key: "Escape" });
    expect(pop.hidden).toBe(true);
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    expect(doc.activeElement).toBe(btn);
  });

  it("sits at the header's far right, after the nav", () => {
    expect(header.children.at(-1)?.id).toBe("appearance");
  });
});

describe("pages", () => {
  const PUBLIC = path.join(process.cwd(), "src", "ui", "server", "public");
  it.each(fs.readdirSync(PUBLIC).filter((f) => f.endsWith(".html")))(
    "%s has a mark slot and no favicon image in the header",
    (f) => {
      const page = fs.readFileSync(path.join(PUBLIC, f), "utf-8");
      expect(page).toMatch(/<span\s+class="den-mark"\s+id="den-mark"/);
      expect(page).not.toMatch(/<img[^>]*src="\/favicon\.ico"/);
    },
  );
});
