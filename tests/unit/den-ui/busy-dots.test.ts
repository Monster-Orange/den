/**
 * den-ui issue 699: a button that sends a request shows pulsing dots until
 * the server answers. The checks that need no browser: busy.js runs on a
 * small stand-in DOM (below) and fake timers; the look is read from
 * busy.css. One test per point of the spec:
 *
 *   1. at once, for every button the kit holds: busyAction's button,
 *      pending()'s button, and a plain POST form's submitter;
 *   2. the markup: .bz-lbl wraps the label, .bz-dots (aria-hidden) has
 *      three dots;
 *   3. the label stays (hidden, so the size is exact) and the accessible
 *      name stays the label; the dots sit over it, centred;
 *   4. three 6px dots, 4px apart, in currentColor;
 *   5. the pulse: 1.2s, delays 0/.16s/.32s;
 *   6. held, not off: opacity 1, cursor progress, hover stops; a second
 *      click does nothing;
 *   7. reduced motion: still dots;
 *   8. the working pop-up opens at 3 s (a setting: dotsMs), dots behind it;
 *      an answer under 3 s gives the label back;
 *   9. the button never shows an error: a quick failure gives the label
 *      back and the error goes where it goes today; after the pop-up, the
 *      pop-up shows it, Try again holds the button again, Close gives the
 *      label back;
 *  10. the phone: nothing of the dots' own sets a width.
 *
 * Plus data-instant="<reason>" (no dots; an empty reason fails the check).
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import * as fs from "fs";
import * as path from "path";

const SRC = path.join(__dirname, "../../../packages/den-ui/src");
const read = (f: string) => fs.readFileSync(path.join(SRC, f), "utf-8");

/* ---------- a stand-in DOM: just what busy.js touches ---------- */

type Listener = (e: FakeEvent) => void;
interface FakeEvent {
  type: string;
  target?: El;
  submitter?: El | null;
  defaultPrevented?: boolean;
  persisted?: boolean;
  preventDefault?: () => void;
}

class El {
  tagName: string;
  childNodes: El[] = [];
  parentNode: El | null = null;
  attrs = new Map<string, string>();
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  disabled = false;
  open = false;
  method = "";
  target = "";
  text = "";
  html = "";
  listeners = new Map<string, Listener[]>();
  /** The elements innerHTML drew that busy.js wires ([data-bz="x"]). */
  drawn = new Map<string, El>();
  constructor(tag: string) {
    this.tagName = tag.toUpperCase();
  }
  get nodeType() {
    return this.tagName === "#TEXT" ? 3 : 1;
  }
  get className() {
    return this.attrs.get("class") ?? "";
  }
  set className(v: string) {
    this.attrs.set("class", v);
  }
  get id() {
    return this.attrs.get("id") ?? "";
  }
  set id(v: string) {
    this.attrs.set("id", v);
  }
  get firstChild() {
    return this.childNodes[0] ?? null;
  }
  get children() {
    return this.childNodes.filter((c) => c.nodeType === 1);
  }
  setAttribute(k: string, v: string) {
    this.attrs.set(k, String(v));
    if (k.startsWith("data-"))
      this.dataset[k.slice(5).replace(/-(\w)/g, (_m, c) => c.toUpperCase())] =
        String(v);
  }
  getAttribute(k: string) {
    return this.attrs.has(k) ? this.attrs.get(k)! : null;
  }
  hasAttribute(k: string) {
    return this.attrs.has(k);
  }
  removeAttribute(k: string) {
    this.attrs.delete(k);
  }
  append(...nodes: (El | string)[]) {
    for (const n of nodes) {
      const el = typeof n === "string" ? textNode(n) : n;
      el.parentNode?.removeChild(el);
      el.parentNode = this;
      this.childNodes.push(el);
    }
  }
  get nextSibling(): El | null {
    const sibs = this.parentNode?.childNodes ?? [];
    return sibs[sibs.indexOf(this) + 1] ?? null;
  }
  insertBefore(n: El, ref: El | null) {
    n.parentNode?.removeChild(n);
    n.parentNode = this;
    const i = ref ? this.childNodes.indexOf(ref) : -1;
    if (i < 0) this.childNodes.push(n);
    else this.childNodes.splice(i, 0, n);
    return n;
  }
  appendChild(n: El) {
    this.append(n);
    return n;
  }
  removeChild(n: El) {
    this.childNodes = this.childNodes.filter((c) => c !== n);
    n.parentNode = null;
    return n;
  }
  remove() {
    this.parentNode?.removeChild(this);
  }
  get textContent(): string {
    if (this.tagName === "#TEXT") return this.text;
    return this.html
      ? this.html.replace(/<[^>]*>/g, "")
      : this.childNodes.map((c) => c.textContent).join("");
  }
  set textContent(v: string) {
    for (const c of this.childNodes) c.parentNode = null;
    this.childNodes = [];
    this.html = "";
    if (this.tagName === "#TEXT") this.text = v;
    else if (v) this.append(textNode(v));
  }
  get innerHTML() {
    return this.html;
  }
  set innerHTML(v: string) {
    this.childNodes = [];
    this.html = v;
    this.drawn = new Map();
  }
  insertAdjacentHTML() {}
  addEventListener(t: string, fn: Listener) {
    this.listeners.set(t, [...(this.listeners.get(t) ?? []), fn]);
  }
  removeEventListener(t: string, fn: Listener) {
    this.listeners.set(
      t,
      (this.listeners.get(t) ?? []).filter((f) => f !== fn),
    );
  }
  dispatch(e: FakeEvent) {
    for (const fn of this.listeners.get(e.type) ?? []) fn(e);
  }
  click() {
    if (this.disabled) return;
    this.dispatch({ type: "click", target: this });
  }
  focus() {
    doc.activeElement = this;
  }
  showModal() {
    this.open = true;
  }
  close() {
    this.open = false;
  }
  getBoundingClientRect() {
    return { width: 120, height: 34 };
  }
  matches(sel: string) {
    if (sel.startsWith("."))
      return this.className.split(/\s+/).includes(sel.slice(1));
    if (sel.startsWith("#")) return this.id === sel.slice(1);
    return this.tagName === sel.toUpperCase();
  }
  querySelector(sel: string): El | null {
    const bz = /^\[data-bz="(\w+)"\]$/.exec(sel);
    if (bz) {
      if (!this.html.includes(`data-bz="${bz[1]}"`)) return null;
      if (!this.drawn.has(bz[1]!)) this.drawn.set(bz[1]!, new El("button"));
      return this.drawn.get(bz[1]!)!;
    }
    return this.querySelectorAll(sel)[0] ?? null;
  }
  querySelectorAll(sel: string): El[] {
    const out: El[] = [];
    const walk = (n: El) => {
      for (const c of n.childNodes) {
        if (c.nodeType === 1 && c.matches(sel)) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
}
const textNode = (s: string) => {
  const t = new El("#text");
  t.text = s;
  return t;
};

const doc = {
  activeElement: null as El | null,
  documentElement: { lang: "en" },
  head: new El("head"),
  body: new El("body"),
  listeners: new Map<string, Listener[]>(),
  createElement: (t: string) => new El(t),
  createTextNode: textNode,
  getElementById(id: string) {
    return (
      doc.head.querySelectorAll(`#${id}`)[0] ??
      doc.body.querySelectorAll(`#${id}`)[0] ??
      null
    );
  },
  querySelectorAll: () => [] as El[],
  addEventListener(t: string, fn: Listener) {
    doc.listeners.set(t, [...(doc.listeners.get(t) ?? []), fn]);
  },
  removeEventListener(t: string, fn: Listener) {
    doc.listeners.set(
      t,
      (doc.listeners.get(t) ?? []).filter((f) => f !== fn),
    );
  },
  dispatch(e: FakeEvent) {
    for (const fn of doc.listeners.get(e.type) ?? []) fn(e);
  },
};
const win = {
  listeners: new Map<string, Listener[]>(),
  addEventListener(t: string, fn: Listener) {
    win.listeners.set(t, [...(win.listeners.get(t) ?? []), fn]);
  },
  removeEventListener(t: string, fn: Listener) {
    win.listeners.set(
      t,
      (win.listeners.get(t) ?? []).filter((f) => f !== fn),
    );
  },
  dispatch(e: FakeEvent) {
    for (const fn of win.listeners.get(e.type) ?? []) fn(e);
  },
  location: { assign: () => {}, href: "http://kit.test/" },
};

/* ---------- busy.js, loaded as a function of its globals ---------- */

type Kit = {
  OPEN_MS: number;
  DOTS_MS: number;
  configureBusy: (h: Record<string, unknown>) => void;
  registerActions: (m: Record<string, unknown>) => void;
  busyAction: (
    name: string,
    run: (h: Record<string, string>) => unknown,
    opts?: Record<string, unknown>,
  ) => Promise<unknown>;
  pending: (
    button: El,
    run: (h: Record<string, string>) => unknown,
    opts?: Record<string, unknown>,
  ) => Promise<unknown>;
  watchForms: (root?: unknown) => () => void;
  instantProblems: (html: string) => string[];
  holdDots: (button: El | null, on?: boolean) => void;
};

/**
 * busy.js is an ES module that reads import.meta (its CSS's address),
 * which jest's CommonJS can't parse: its text is run as a function here,
 * its imports passed in and its exports handed back.
 */
function loadKit(): Kit {
  const words = new Function(
    read("busy-words.js").replace(/export\s+const\s+BUSY_WORDS\s*=/, "return"),
  )();
  let src = read("busy.js");
  const names = [
    ...src.matchAll(/^export\s+(?:async\s+)?(?:function|const)\s+(\w+)/gm),
  ].map((m) => m[1]!);
  src = src
    .replace(/^import .*$/gm, "")
    .replace(/import\.meta\.url/g, JSON.stringify("http://kit.test/busy.js"))
    .replace(/^export\s+/gm, "");
  return new Function("BUSY_WORDS", `${src}\nreturn { ${names.join(", ")} };`)(
    words,
  ) as Kit;
}

const g = globalThis as unknown as Record<string, unknown>;
let kit: Kit;
let toasts: string[];

/** Runs the clock and lets each settled promise's callbacks run. */
async function tick(ms: number) {
  await jest.advanceTimersByTimeAsync(ms);
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

/** A request answered after `ms`: ok, or an error answer (status). */
const answer = (ms: number, status = 200) =>
  new Promise((res, rej) =>
    setTimeout(
      () => (status < 400 ? res({ ok: true }) : rej({ status, message: "no" })),
      ms,
    ),
  );

function button(label = "Save changes") {
  const b = new El("button");
  b.append(label);
  doc.body.append(b);
  return b;
}
const dialog = () => doc.body.querySelectorAll("dialog")[0] ?? null;
const held = (b: El) =>
  b.disabled &&
  b.getAttribute("aria-busy") === "true" &&
  b.querySelectorAll(".bz-dots").length === 1;

beforeEach(() => {
  jest.useFakeTimers({ now: new Date("2026-11-19T10:00:00Z") });
  doc.head = new El("head");
  doc.body = new El("body");
  doc.listeners = new Map();
  win.listeners = new Map();
  g.document = doc;
  g.window = win;
  g.location = { href: "http://kit.test/" };
  g.customElements = {
    get: () => true,
    define: () => {},
  };
  kit = loadKit();
  toasts = [];
  kit.configureBusy({ toast: (t: string) => toasts.push(t) });
  const w = (x: Record<string, string>) => ({ en: x, es: x, ja: x });
  kit.registerActions({
    save: {
      who: "Probe",
      words: w({ working: "Saving", success: "Saved", failure: "Not saved" }),
    },
    quick: {
      who: "Probe",
      inline: true,
      words: w({ working: "Checking", success: "Fine", failure: "Not fine" }),
    },
  });
});
afterEach(() => {
  jest.useRealTimers();
});

const CSS = () => read("busy.css");
/** The declarations of the first rule whose selector is exactly `sel`. */
function rule(css: string, sel: string): string {
  const i = css.indexOf(`${sel} {`);
  if (i < 0) return "";
  return css.slice(i + sel.length + 2, css.indexOf("}", i));
}

describe("issue 699, 1: dots at once, for every button the kit holds", () => {
  it("busyAction's button", async () => {
    const b = button();
    void kit.busyAction("save", () => answer(5000), { button: b });
    expect(held(b)).toBe(true);
  });
  it("pending()'s button", async () => {
    const b = button();
    void kit.pending(b, () => answer(5000));
    expect(held(b)).toBe(true);
  });
  it("a plain POST form's submitter, and not a GET form's", async () => {
    const stop = kit.watchForms();
    const form = new El("form");
    form.method = "post";
    const b = button("Send");
    form.append(b);
    let prevented = false;
    doc.dispatch({
      type: "submit",
      target: form,
      submitter: b,
      preventDefault: () => (prevented = true),
    });
    // The dots at once; the submitter is disabled only after the browser
    // took its name and value into the form's data.
    expect(b.querySelectorAll(".bz-dots")).toHaveLength(1);
    expect(b.getAttribute("aria-busy")).toBe("true");
    expect(prevented).toBe(false);
    await tick(0);
    expect(held(b)).toBe(true);
    // A second submit while held is stopped.
    doc.dispatch({
      type: "submit",
      target: form,
      submitter: b,
      preventDefault: () => (prevented = true),
    });
    expect(prevented).toBe(true);
    // Back (the browser's back-forward cache): the label is back.
    win.dispatch({ type: "pageshow", persisted: true });
    expect(b.disabled).toBe(false);
    expect(b.querySelectorAll(".bz-dots")).toHaveLength(0);

    const get = new El("form");
    get.method = "get";
    const c = button("Find");
    get.append(c);
    doc.dispatch({ type: "submit", target: get, submitter: c });
    expect(c.getAttribute("aria-busy")).toBeNull();
    stop();
    const again = button("Again");
    form.append(again);
    doc.dispatch({ type: "submit", target: form, submitter: again });
    expect(again.getAttribute("aria-busy")).toBeNull();
  });
});

describe("issue 699, 2: the markup", () => {
  it("the label in .bz-lbl, then .bz-dots (aria-hidden) with three dots", () => {
    const b = button();
    void kit.pending(b, () => answer(5000));
    const kids = b.children;
    expect(kids.map((k) => k.className)).toEqual(["bz-lbl", "bz-dots"]);
    expect(kids[0]!.textContent).toBe("Save changes");
    expect(kids[1]!.getAttribute("aria-hidden")).toBe("true");
    expect(kids[1]!.children.map((i) => i.tagName)).toEqual(["I", "I", "I"]);
  });
});

describe("issue 699, 3: the label stays; the name stays the label", () => {
  it("the label's own nodes are kept, and the accessible name is the label", async () => {
    const b = button();
    const icon = new El("svg");
    b.append(icon);
    void kit.pending(b, () => answer(100));
    expect(b.children[0]!.childNodes).toContain(icon);
    expect(b.getAttribute("aria-label")).toBe("Save changes");
    await tick(100);
    expect(b.childNodes).toContain(icon);
    expect(b.textContent).toBe("Save changes");
    expect(b.getAttribute("aria-label")).toBeNull();
  });
  it("a page that draws the button again while it waits keeps its own label", async () => {
    const b = button("Start");
    void kit.busyAction("save", () => answer(500), { button: b });
    b.textContent = "Working…";
    await tick(500);
    expect(b.textContent).toBe("Working…");
    expect(b.disabled).toBe(false);
  });
  it("a button's own aria-label is kept as it was", async () => {
    const b = button();
    b.setAttribute("aria-label", "Save the plan");
    void kit.pending(b, () => answer(100));
    expect(b.getAttribute("aria-label")).toBe("Save the plan");
    await tick(100);
    expect(b.getAttribute("aria-label")).toBe("Save the plan");
  });
  it("busy.css hides the label (keeps its size) and centres the dots over it", () => {
    const css = CSS();
    expect(rule(css, '[aria-busy="true"] > .bz-lbl')).toMatch(
      /visibility:\s*hidden/,
    );
    const dots = rule(css, '[aria-busy="true"] > .bz-dots');
    for (const d of [
      /position:\s*absolute/,
      /inset:\s*0/,
      /display:\s*flex/,
      /align-items:\s*center/,
      /justify-content:\s*center/,
    ])
      expect(dots).toMatch(d);
    expect(rule(css, '[aria-busy="true"]:is(button, .btn, a)')).toMatch(
      /position:\s*relative/,
    );
  });
});

describe("issue 699, 4 and 5: the dots and their pulse", () => {
  it("three 6px dots, 4px apart, in the label's colour", () => {
    const css = CSS();
    expect(rule(css, '[aria-busy="true"] > .bz-dots')).toMatch(/gap:\s*4px/);
    const dot = rule(css, ".bz-dots > i");
    expect(dot).toMatch(/width:\s*6px/);
    expect(dot).toMatch(/height:\s*6px/);
    expect(dot).toMatch(/border-radius:\s*50%/);
    expect(dot).toMatch(/background:\s*currentColor/);
  });
  it("1.2s ease-in-out, 0/.16s/.32s, .3 to 1", () => {
    const css = CSS();
    expect(rule(css, ".bz-dots > i")).toMatch(
      /animation:\s*bz-dot 1\.2s ease-in-out infinite/,
    );
    expect(rule(css, ".bz-dots > i:nth-child(2)")).toMatch(
      /animation-delay:\s*0?\.16s/,
    );
    expect(rule(css, ".bz-dots > i:nth-child(3)")).toMatch(
      /animation-delay:\s*0?\.32s/,
    );
    const k = css.slice(css.indexOf("@keyframes bz-dot"));
    expect(k).toMatch(
      /0%,\s*80%,\s*100%\s*\{\s*opacity:\s*0?\.3;\s*transform:\s*scale\(0?\.85\);?\s*\}/,
    );
    expect(k).toMatch(
      /40%\s*\{\s*opacity:\s*1;\s*transform:\s*scale\(1\);?\s*\}/,
    );
  });
  it("no colour of its own: no hex, rgb or hsl in the dots' rules", () => {
    const css = CSS();
    const part = css.slice(css.indexOf("issue 699"));
    expect(part).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i);
  });
});

describe("issue 699, 6: held, not off", () => {
  it("opacity 1 while disabled (over the button's own off look), cursor progress", () => {
    const css = CSS();
    expect(rule(css, '[aria-busy="true"]:is(button, .btn, a)')).toMatch(
      /cursor:\s*progress/,
    );
    expect(css).toMatch(
      /\.den-btn\[aria-busy="true"\]:disabled[^{]*\{\s*opacity:\s*1;?\s*\}/,
    );
  });
  it("hover stops: the kit button's hover skips a held button", () => {
    expect(read("button.css")).toMatch(
      /\.den-btn:not\(\[aria-busy="true"\]\):hover\s*\{/,
    );
    expect(read("button.css")).not.toMatch(/\.den-btn:hover\s*\{/);
  });
  it("a second click does nothing: pending() on a held button sends nothing", async () => {
    const b = button();
    let runs = 0;
    const run = () => {
      runs++;
      return answer(1000);
    };
    void kit.pending(b, run);
    await expect(kit.pending(b, run)).resolves.toBeNull();
    expect(runs).toBe(1);
  });
});

describe("issue 699, 7: reduced motion", () => {
  it("no pulse: opacity .75, scale 1", () => {
    const css = CSS();
    const i = css.lastIndexOf("@media (prefers-reduced-motion: reduce)");
    const block = css.slice(i, css.indexOf("}\n}", i) + 3);
    expect(block).toMatch(
      /\.bz-dots > i\s*\{\s*animation:\s*none;\s*opacity:\s*0?\.75;\s*transform:\s*none;?\s*\}/,
    );
  });
});

describe("issue 699, 8: the working pop-up at 3 s, a setting", () => {
  it("the default is 3000 ms, exported as DOTS_MS", () => {
    expect(kit.DOTS_MS).toBe(3000);
  });
  it("opens at 3000 ms, not before; the dots stay behind it", async () => {
    const b = button();
    void kit.busyAction("save", () => answer(10_000), { button: b });
    await tick(2999);
    expect(dialog()?.open ?? false).toBe(false);
    await tick(1);
    expect(dialog()?.open).toBe(true);
    expect(held(b)).toBe(true);
  });
  it("configureBusy({ dotsMs }) moves it", async () => {
    kit.configureBusy({ dotsMs: 1000 });
    const b = button();
    void kit.busyAction("save", () => answer(10_000), { button: b });
    await tick(999);
    expect(dialog()?.open ?? false).toBe(false);
    await tick(1);
    expect(dialog()?.open).toBe(true);
  });
  it("no button (nothing shows dots): OPEN_MS as before", async () => {
    void kit.busyAction("save", () => answer(10_000));
    await tick(kit.OPEN_MS);
    expect(dialog()?.open).toBe(true);
  });
  it("an answer under 3 s gives the label back, with no pop-up; said as today", async () => {
    const b = button();
    const out = kit.busyAction("save", () => answer(2500), { button: b });
    await tick(2500);
    await expect(out).resolves.toEqual({ ok: true });
    expect(dialog()).toBeNull();
    expect(b.disabled).toBe(false);
    expect(b.getAttribute("aria-busy")).toBeNull();
    expect(b.querySelectorAll(".bz-dots")).toHaveLength(0);
    expect(b.querySelectorAll(".bz-lbl")).toHaveLength(0);
    expect(b.textContent).toBe("Save changes");
    expect(toasts).toEqual(["Saved"]);
  });
  it("pending(): resolves with the answer and gives the label back", async () => {
    const b = button();
    const res = { ok: true, status: 200 };
    const out = kit.pending(
      b,
      () => new Promise((r) => setTimeout(() => r(res), 500)),
    );
    await tick(500);
    await expect(out).resolves.toBe(res);
    expect(b.disabled).toBe(false);
    expect(b.textContent).toBe("Save changes");
  });
  it("pending() sends the request id in the headers it hands over", async () => {
    const b = button();
    let seen: Record<string, string> = {};
    void kit.pending(b, (h) => {
      seen = h;
      return answer(10);
    });
    // The request starts on the next turn (as busyAction's always has).
    await tick(0);
    expect(Object.keys(seen)).toEqual(["X-Request-Id"]);
  });
});

describe("issue 699, 9: the button never shows an error", () => {
  it("a quick failure: the label back, enabled, and the failure pop-up with Try again", async () => {
    const b = button();
    void kit.busyAction("save", () => answer(500, 500), { button: b });
    await tick(500);
    expect(b.disabled).toBe(false);
    expect(b.querySelectorAll(".bz-dots")).toHaveLength(0);
    expect(dialog()?.open).toBe(true);
    expect(dialog()?.innerHTML).toContain('data-bz="retry"');
  });
  it("a quick failure of an inline action goes back to the caller, label back", async () => {
    const b = button();
    const out = kit.busyAction("quick", () => answer(500, 500), {
      button: b,
    });
    const caught = out.catch((e) => e);
    await tick(500);
    await expect(caught).resolves.toMatchObject({ status: 500 });
    expect(b.disabled).toBe(false);
    expect(b.querySelectorAll(".bz-dots")).toHaveLength(0);
    expect(dialog()).toBeNull();
  });
  it("pending(): an error answer (a Response that isn't ok) is the failure pop-up with Try again", async () => {
    const b = button();
    void kit.pending(b, () =>
      Promise.resolve({
        ok: false,
        status: 502,
        clone: () => ({ json: () => Promise.resolve({ error: "down" }) }),
      }),
    );
    await tick(0);
    expect(dialog()?.open).toBe(true);
    expect(dialog()?.innerHTML).toContain('data-bz="retry"');
    expect(dialog()?.innerHTML).toContain("(502)");
    expect(b.disabled).toBe(false);
  });
  it("pending(): no answer at all (fetch threw) is the failure pop-up too", async () => {
    const b = button();
    void kit.pending(b, () => Promise.reject(new TypeError("Failed to fetch")));
    await tick(0);
    expect(dialog()?.open).toBe(true);
    expect(dialog()?.innerHTML).toContain('data-bz="retry"');
  });
  it("after the pop-up: it shows the failure; Try again holds the button again; Close gives the label back", async () => {
    const b = button();
    let n = 0;
    void kit.busyAction(
      "save",
      () => (++n === 1 ? answer(4000, 500) : answer(10_000)),
      { button: b },
    );
    await tick(3000);
    expect(dialog()?.open).toBe(true);
    await tick(1000);
    expect(dialog()?.dataset.state).toBe("failure");
    expect(held(b)).toBe(true);
    dialog()!.querySelector('[data-bz="retry"]')!.click();
    expect(held(b)).toBe(true);
    await tick(0);
    expect(n).toBe(2);
    expect(dialog()?.dataset.state).toBe("working");
    await tick(10_000);
    // The second answer (ok) closes it; the label is back.
    expect(b.disabled).toBe(false);
    expect(b.querySelectorAll(".bz-dots")).toHaveLength(0);
  });
  it("Close on a failure gives the label back", async () => {
    const b = button();
    void kit.busyAction("save", () => answer(4000, 500), { button: b });
    await tick(4000);
    expect(held(b)).toBe(true);
    dialog()!.querySelector('[data-bz="close"]')!.click();
    expect(b.disabled).toBe(false);
    expect(b.querySelectorAll(".bz-dots")).toHaveLength(0);
    expect(b.textContent).toBe("Save changes");
  });
});

describe("issue 699, 10: the phone", () => {
  it("nothing of the dots' own sets a width or height on the button", () => {
    const css = CSS();
    const part = css.slice(css.indexOf("issue 699"));
    const btnRules = [...part.matchAll(/\[aria-busy="true"\][^{]*\{([^}]*)\}/g)]
      .map((m) => m[1])
      .join("");
    expect(btnRules).not.toMatch(/(^|[^-])(width|height)\s*:/);
  });
});

describe('issue 699: data-instant="<reason>"', () => {
  it("a button with a reason is held without dots, and its pop-up waits OPEN_MS", async () => {
    const b = button();
    b.setAttribute("data-instant", "only reads a local list");
    void kit.busyAction("save", () => answer(10_000), { button: b });
    expect(b.disabled).toBe(true);
    expect(b.querySelectorAll(".bz-dots")).toHaveLength(0);
    await tick(kit.OPEN_MS);
    expect(dialog()?.open).toBe(true);
  });
  it("the check finds a data-instant with no reason (it can fail)", () => {
    expect(
      kit.instantProblems('<button data-instant="">Go</button>'),
    ).toHaveLength(1);
    expect(
      kit.instantProblems("<button data-instant>Go</button>"),
    ).toHaveLength(1);
    expect(
      kit.instantProblems('<button data-instant="  ">Go</button>'),
    ).toHaveLength(1);
    expect(
      kit.instantProblems('<button data-instant="opens a menu">Go</button>'),
    ).toEqual([]);
  });
  it("a button with an empty reason still shows dots (the opt-out doesn't count)", () => {
    const b = button();
    b.setAttribute("data-instant", "");
    void kit.pending(b, () => answer(1000));
    expect(held(b)).toBe(true);
  });
  it("no kit file and no page Den serves has a data-instant with no reason", () => {
    const dirs = [SRC, path.join(__dirname, "../../../src/ui/server/public")];
    const bad: string[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(html|js|mjs)$/.test(e.name))
          for (const hit of kit.instantProblems(fs.readFileSync(p, "utf-8")))
            bad.push(`${path.relative(process.cwd(), p)}: ${hit}`);
      }
    };
    for (const d of dirs) walk(d);
    expect(bad).toEqual([]);
  });
});

describe("issue 698: holdDots, the dots alone (a wait with its own words)", () => {
  it("holds the button with dots at once and opens no pop-up, however long", async () => {
    const b = button("Unlock");
    kit.holdDots(b);
    expect(held(b)).toBe(true);
    expect(b.getAttribute("aria-label")).toBe("Unlock");
    await tick(60_000);
    expect(dialog()).toBeNull();
    expect(held(b)).toBe(true);
  });
  it("holdDots(button, false) gives the label back, enabled", () => {
    const b = button("Unlock");
    kit.holdDots(b);
    kit.holdDots(b, false);
    expect(b.disabled).toBe(false);
    expect(b.getAttribute("aria-busy")).toBeNull();
    expect(b.querySelectorAll(".bz-dots")).toHaveLength(0);
    expect(b.textContent).toBe("Unlock");
    expect(b.getAttribute("aria-label")).toBeNull();
  });
  it("a second hold is one set of dots; a page's new label stays on release", () => {
    const b = button("Sign in");
    kit.holdDots(b);
    kit.holdDots(b);
    expect(b.querySelectorAll(".bz-dots")).toHaveLength(1);
    b.textContent = "Try again";
    kit.holdDots(b, false);
    expect(b.textContent).toBe("Try again");
  });
  it("no button: nothing happens", () => {
    expect(() => kit.holdDots(null)).not.toThrow();
  });
});
