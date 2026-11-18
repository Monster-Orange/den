/**
 * den-ui: the Report form's screenshot, and its mask.
 *
 * capture() takes the page as the person sees it, with any dialog, drawer
 * or menu that is open (the form itself is left out). It makes its own
 * lean copy of the page (issue 469); html-to-image (MIT; the product serves
 * it and names its URL with configureShots({ library })) is loaded only if
 * that fails. It never throws: a
 * page that can't be captured, or that takes longer than `seconds`, gives
 * null, and the form offers to send without one.
 *
 * Masks are rectangles in fractions of the image (0..1), so they hold at
 * any size the image is shown at. masked() draws them in black onto a
 * copy: what is sent is the copy, never the original.
 *
 * The screenshot never goes to the product's server. GitHub's API can't attach an
 * image, so after sending it is saved as a file and copied, and the person
 * pastes it into the issue.
 */

let LIB = "";
let lib = null;

/** Where html-to-image is (a URL on the product's own origin). */
export function configureShots({ library } = {}) {
  if (library && library !== LIB) {
    LIB = library;
    lib = null;
  }
}

function loadLib() {
  if (lib) return lib;
  lib = new Promise((ok, no) => {
    if (window.htmlToImage) return ok(window.htmlToImage);
    if (!LIB) return no(new Error("html-to-image: no library configured"));
    const sc = document.createElement("script");
    sc.src = LIB;
    sc.onload = () =>
      window.htmlToImage
        ? ok(window.htmlToImage)
        : no(new Error("html-to-image"));
    sc.onerror = () => no(new Error("html-to-image"));
    document.head.append(sc);
  });
  lib.catch(() => (lib = null));
  return lib;
}

const TIMED_OUT = "capture timed out";

function timeout(ms) {
  return new Promise((_, no) => setTimeout(() => no(new Error(TIMED_OUT)), ms));
}

/*
 * Scroll (issue 295). html-to-image clones the page, and a clone starts at
 * scrollTop 0: the window and every scrolled pane would show their top.
 * So, before cloning, each scrolled element's children (and each sticky
 * element) are tagged with a data attribute; after cloning, the SVG is
 * edited so each tagged clone sits where the person sees it:
 *
 * - the window's scroll moves the root clone up (position: relative, top
 *   and left), so fixed parts (the top bar, the rail) stay put;
 * - a scrolled element's children move up by its scrollTop/scrollLeft
 *   (position: relative, or their own top/left for positioned ones); its
 *   bare text is wrapped in a span that moves the same way. Nested panes
 *   add up, since each moves inside its parent;
 * - a sticky element becomes position: relative with the offset sticky
 *   gave it on screen (measured by setting it static for one synchronous
 *   read, so nothing is painted).
 *
 * The image stays the window's size: what is on screen, not the page.
 */
const TAG = "data-den-shot";

const px = (v) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
};

/**
 * What to change in the clone: [{ el, css, text }], one per live element.
 * `css` is appended to the clone's style; `text` ({ dx, dy }) moves the
 * element's bare text.
 */
function scrollPlan(skip) {
  const se = document.scrollingElement || document.documentElement;
  const steps = new Map(); // el -> { dx, dy, sticky, clip, text }
  const step = (el) => {
    let m = steps.get(el);
    if (!m) {
      m = { dx: 0, dy: 0, sticky: false, clip: false, text: null };
      steps.set(el, m);
    }
    return m;
  };
  for (const el of document.body ? document.body.querySelectorAll("*") : []) {
    if (el === se || skip(el)) continue;
    if (getComputedStyle(el).position === "sticky") {
      // Where sticky put it, against where it would be without: read with
      // position static for one synchronous moment (nothing is painted).
      const before = el.getBoundingClientRect();
      const v = el.style.getPropertyValue("position");
      const pr = el.style.getPropertyPriority("position");
      el.style.setProperty("position", "static", "important");
      const flat = el.getBoundingClientRect();
      if (v) el.style.setProperty("position", v, pr);
      else el.style.removeProperty("position");
      const m = step(el);
      m.sticky = true;
      m.dx += before.left - flat.left;
      m.dy += before.top - flat.top;
    }
    const st = el.scrollTop;
    const sl = el.scrollLeft;
    if (!st && !sl) continue;
    // A clone can't scroll: no scrollbar (it would show the top), and its
    // children move instead.
    step(el).clip = true;
    for (const c of el.childNodes) {
      if (c.nodeType === 3 && c.nodeValue.trim())
        step(el).text = { dx: -sl, dy: -st };
      if (c.nodeType !== 1 || skip(c)) continue;
      if (getComputedStyle(c).position === "fixed") continue;
      const m = step(c);
      m.dx -= sl;
      m.dy -= st;
    }
  }
  const plan = [];
  for (const [el, m] of steps) {
    let css = m.clip ? "overflow:hidden;" : "";
    if (m.dx || m.dy || m.sticky) {
      const cs = getComputedStyle(el);
      if (cs.position === "absolute" || cs.position === "relative")
        css +=
          `top:${px(cs.top) + m.dy}px;bottom:${px(cs.bottom) - m.dy}px;` +
          `left:${px(cs.left) + m.dx}px;right:${px(cs.right) - m.dx}px;`;
      else
        css += `position:relative;top:${m.dy}px;left:${m.dx}px;bottom:auto;right:auto;`;
      // Sticky parts stay above the content that scrolls under them, now
      // that the moved content is positioned too.
      if (m.sticky && cs.zIndex === "auto") css += "z-index:1;";
    }
    if (css || m.text) plan.push({ el, css, text: m.text });
  }
  return plan;
}

/** The SVG (a data: URL) with each tagged clone changed as planned. */
function applyPlan(url, plan) {
  const head = "data:image/svg+xml;charset=utf-8,";
  const doc = new DOMParser().parseFromString(
    decodeURIComponent(url.slice(head.length)),
    "image/svg+xml",
  );
  if (doc.getElementsByTagName("parsererror").length) return url;
  const byTag = new Map();
  for (const n of doc.querySelectorAll(`[${TAG}]`)) {
    byTag.set(n.getAttribute(TAG), n);
    n.removeAttribute(TAG);
  }
  plan.forEach((step, i) => {
    const n = byTag.get(String(i));
    if (!n) return;
    // Last in the attribute, so it wins over the copied computed style.
    if (step.css)
      n.setAttribute("style", `${n.getAttribute("style") || ""};${step.css}`);
    if (!step.text) return;
    for (const c of [...n.childNodes]) {
      if (c.nodeType !== 3 || !c.nodeValue.trim()) continue;
      const span = doc.createElementNS(n.namespaceURI, "span");
      span.setAttribute(
        "style",
        `position:relative;top:${step.text.dy}px;left:${step.text.dx}px;`,
      );
      n.replaceChild(span, c);
      span.append(c);
    }
  });
  return head + encodeURIComponent(new XMLSerializer().serializeToString(doc));
}

function imageOf(url) {
  return new Promise((ok, no) => {
    const img = new Image();
    img.onload = () =>
      img
        .decode()
        .catch(() => {})
        .then(() => requestAnimationFrame(() => ok(img)));
    img.onerror = no;
    img.decoding = "async";
    img.src = url;
  });
}

/**
 * The page as shown now, as a canvas the size of the window, or null.
 * `skip(el)`: elements to leave out (the form). The lean copy first
 * (below); html-to-image only if it fails.
 */
export async function capture({ seconds = 15, skip = () => false } = {}) {
  try {
    return await Promise.race([lean(skip), timeout(seconds * 1000)]);
  } catch (err) {
    // Too slow: none. Anything else: the library's way.
    if (err?.message === TIMED_OUT) return null;
    return viaLibrary(seconds, skip);
  }
}

/*
 * The lean copy (issue 469). html-to-image writes every computed style of
 * every element into the copy: on a full page that is tens of MB of SVG,
 * seconds to build, parse and draw. This copy writes only what differs
 * from what the copy would get anyway:
 *
 * - a property the element inherits: only when it differs from its
 *   parent's (or the browser's own style for that tag sets it);
 * - any other property: only when it differs from the browser's default
 *   for that tag, read once per tag in an empty frame of the same page.
 *
 * A property not known to be inherited is compared with the default: at
 * worst written when it need not be, never left out when it must be.
 * Hidden elements (display: none) are left out. Images and url()s are
 * inlined, each URL fetched once per page. The scroll plan is written into
 * the copy as it is made (no parse of the SVG back). The copy yields to
 * the page every few milliseconds, so the open form keeps taking keys.
 */
const SVG_NS = "http://www.w3.org/2000/svg";
const BOX = "data-den-shot-box";
const INHERITED = new Set([
  "color",
  "direction",
  "font-family",
  "font-size",
  "font-style",
  "font-weight",
  "font-stretch",
  "font-variant",
  "font-variant-caps",
  "font-variant-ligatures",
  "font-variant-numeric",
  "font-variant-east-asian",
  "font-feature-settings",
  "font-variation-settings",
  "font-kerning",
  "font-optical-sizing",
  "font-size-adjust",
  "line-height",
  "letter-spacing",
  "word-spacing",
  "text-align",
  "text-align-last",
  "text-indent",
  "text-transform",
  "text-shadow",
  "text-rendering",
  "text-underline-position",
  "white-space",
  "white-space-collapse",
  "text-wrap",
  "text-wrap-mode",
  "text-wrap-style",
  "word-break",
  "overflow-wrap",
  "word-wrap",
  "line-break",
  "hyphens",
  "tab-size",
  "visibility",
  "list-style-type",
  "list-style-position",
  "list-style-image",
  "quotes",
  "border-collapse",
  "border-spacing",
  "caption-side",
  "empty-cells",
  "writing-mode",
  "text-orientation",
  "color-scheme",
  "-webkit-font-smoothing",
  "-webkit-text-fill-color",
  "-webkit-text-stroke-color",
  "-webkit-text-stroke-width",
  "-webkit-locale",
  "-webkit-writing-mode",
  "fill",
  "fill-opacity",
  "fill-rule",
  "stroke",
  "stroke-width",
  "stroke-opacity",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-dasharray",
  "stroke-dashoffset",
  "paint-order",
]);
// Nothing a still picture shows.
const NOT_DRAWN =
  /^(--|transition|animation|scroll-|overscroll|touch-action|user-select|-webkit-user-|cursor$|will-change|caret-color|pointer-events|view-transition|-webkit-tap-highlight|interactivity|interpolate-size|timeline-|anchor-|position-try|-webkit-line-break)/;
// Not copied at all: what draws nothing, or what the copy can't load.
const LEFT_OUT = new Set([
  "SCRIPT",
  "NOSCRIPT",
  "STYLE",
  "LINK",
  "TEMPLATE",
  "META",
  "TITLE",
  "BASE",
  "HEAD",
  "SOURCE",
  "TRACK",
]);

let box = null;

/** The empty frame the defaults are read in, made once per page. */
function frame() {
  if (box && box.frame.isConnected && box.frame.contentDocument?.body)
    return box;
  const f = document.createElement("iframe");
  f.setAttribute(BOX, "");
  f.setAttribute("aria-hidden", "true");
  f.tabIndex = -1;
  f.style.cssText =
    "position:fixed;left:-10000px;top:0;width:200px;height:200px;border:0;visibility:hidden;pointer-events:none";
  document.documentElement.append(f);
  const doc = f.contentDocument;
  if (!doc) throw new Error("no frame");
  doc.open();
  doc.write("<!doctype html><html><head></head><body></body></html>");
  doc.close();
  const win = f.contentWindow;
  const cs = win.getComputedStyle(doc.body);
  const names = [];
  for (let i = 0; i < cs.length; i++)
    if (!NOT_DRAWN.test(cs[i])) names.push(cs[i]);
  if (!names.length) throw new Error("no computed style in the frame");
  box = {
    frame: f,
    doc,
    win,
    names,
    inh: names.map((n) => INHERITED.has(n)),
    tags: new Map(),
  };
  return box;
}

/**
 * The browser's own style for a tag: each property's value, and whether
 * its style sheet sets an inherited one (so it can't be left to the
 * parent).
 */
function defaultsOf(b, el) {
  const svg = el.namespaceURI === SVG_NS;
  const key = (svg ? "svg:" : "") + el.localName;
  let d = b.tags.get(key);
  if (d) return d;
  const probe = svg
    ? b.doc.createElementNS(SVG_NS, el.localName)
    : b.doc.createElement(el.localName);
  b.doc.body.append(probe);
  const cs = b.win.getComputedStyle(probe);
  const body = b.win.getComputedStyle(b.doc.body);
  const vals = b.names.map((n) => cs.getPropertyValue(n));
  const ua = b.names.map(
    (n, i) => b.inh[i] && vals[i] !== body.getPropertyValue(n),
  );
  probe.remove();
  d = { vals, ua };
  b.tags.set(key, d);
  return d;
}

/** The declarations to write for one element, and its values (for its children). */
function declsOf(b, cs, d, parent) {
  const { names, inh } = b;
  const vals = new Array(names.length);
  let css = "";
  for (let i = 0; i < names.length; i++) {
    const v = cs.getPropertyValue(names[i]);
    vals[i] = v;
    if (!v) continue;
    const write = inh[i]
      ? !parent || d.ua[i] || v !== parent[i]
      : v !== d.vals[i];
    if (write) css += `${names[i]}:${v};`;
  }
  return { css, vals };
}

const inlined = new Map();

/** A URL's content as a data: URL, fetched once per page ("" if it can't be). */
function dataUrlOf(url) {
  let abs;
  try {
    abs = new URL(url, location.href).href;
  } catch {
    return Promise.resolve("");
  }
  if (abs.startsWith("data:")) return Promise.resolve(abs);
  let p = inlined.get(abs);
  if (!p) {
    p = fetch(abs)
      .then((r) => (r.ok ? r.blob() : null))
      .then((blob) =>
        blob
          ? new Promise((ok) => {
              const fr = new FileReader();
              fr.onload = () => ok(String(fr.result || ""));
              fr.onerror = () => ok("");
              fr.readAsDataURL(blob);
            })
          : "",
      )
      .catch(() => "");
    inlined.set(abs, p);
  }
  return p;
}

const URL_RE = /url\((["']?)([^"')]+)\1\)/g;

/** css with each url() it names inlined (none dropped silently: "" stays ""). */
async function inlineUrls(css) {
  const urls = new Set();
  for (const m of css.matchAll(URL_RE))
    if (!m[2].startsWith("data:") && !m[2].startsWith("#")) urls.add(m[2]);
  if (!urls.size) return css;
  const got = new Map();
  await Promise.all([...urls].map(async (u) => got.set(u, await dataUrlOf(u))));
  return css.replace(URL_RE, (all, q, u) =>
    got.has(u) ? (got.get(u) ? `url("${got.get(u)}")` : "none") : all,
  );
}

/** Whether an element is in the top layer (a modal dialog, a popover). */
function onTop(el) {
  try {
    return el.matches(":modal") || el.matches(":popover-open");
  } catch {
    return false;
  }
}

async function lean(skip) {
  const b = frame();
  const width = window.innerWidth;
  const height = window.innerHeight;
  const backgroundColor = getComputedStyle(document.body).backgroundColor;
  const skipEl = (el) => el.hasAttribute(BOX) || skip(el);
  const steps = new Map();
  for (const s of scrollPlan(skipEl)) steps.set(s.el, s);
  const root = document.documentElement;
  const x = window.scrollX;
  const y = window.scrollY;
  if (x || y) {
    const s = steps.get(root) || { el: root, css: "", text: null };
    s.css += `position:relative;top:${-y}px;left:${-x}px;bottom:auto;right:auto;`;
    steps.set(root, s);
  }

  const late = []; // [copy, css] whose url()s are inlined before drawing
  const imgs = []; // [copy, src]
  const pseudo = []; // style rules for ::before / ::after
  let pn = 0;
  const setStyle = (copy, css) => {
    if (css.includes("url(")) late.push([copy, css]);
    // Through the CSSOM, never the attribute: a page whose CSP has no
    // 'unsafe-inline' for styles allows it.
    else if (css) copy.style.cssText = css;
  };

  /** One element's copy (not its children), or null when it draws nothing. */
  const copyOf = (el, parent) => {
    const cs = getComputedStyle(el);
    if (cs.display === "none") return null;
    const svg = el.namespaceURI === SVG_NS;
    const tag = el.localName;
    let copy;
    if (svg) copy = el.cloneNode(true);
    else if (tag === "canvas" || tag === "video" || tag === "iframe") {
      let src = "";
      try {
        if (tag === "canvas") src = el.toDataURL();
      } catch {
        /* a tainted canvas: drawn as its box */
      }
      copy = document.createElement(src ? "img" : "div");
      if (src) copy.setAttribute("src", src);
    } else {
      // A defined custom element would run its own code: a plain span
      // (an unknown tag's defaults) stands in.
      copy = document.createElement(
        tag.includes("-") && customElements.get(tag) ? "span" : tag,
      );
      for (const a of el.attributes) {
        const n = a.name;
        if (
          n === "style" ||
          n === "src" ||
          n === "srcset" ||
          n === "loading" ||
          n === "decoding" ||
          // display decides, already written: these would hide the copy.
          n === "hidden" ||
          n === "popover" ||
          n === TAG ||
          n.startsWith("on")
        )
          continue;
        try {
          copy.setAttribute(n, a.value);
        } catch {
          /* a name XML can't carry */
        }
      }
    }
    if (tag === "img" && !svg) {
      const src = el.currentSrc || el.src;
      if (src && el.complete && el.naturalWidth) imgs.push([copy, src]);
    }
    if (tag === "input") {
      if (el.type === "checkbox" || el.type === "radio") {
        if (el.checked) copy.setAttribute("checked", "");
        else copy.removeAttribute("checked");
      } else if (el.type !== "file" && el.type !== "password")
        copy.setAttribute("value", el.value);
    }
    if (tag === "textarea") copy.textContent = el.value;
    if (tag === "option") {
      if (el.selected) copy.setAttribute("selected", "");
      else copy.removeAttribute("selected");
    }
    const d = defaultsOf(b, el);
    const { css, vals } = declsOf(b, cs, d, parent);
    let more = "";
    const step = steps.get(el);
    if (step?.css) more += step.css;
    if (onTop(el)) more += "z-index:2147483646;";
    if (el === root) more += `width:${width}px;height:${height}px;`;
    setStyle(copy, css + more);
    if (!svg) {
      for (const which of ["::before", "::after"]) {
        const ps = getComputedStyle(el, which);
        const content = ps.getPropertyValue("content");
        if (!content || content === "none" || content === "normal") continue;
        const pd = defaultsOf(b, { localName: "span" });
        const p = declsOf(b, ps, pd, vals).css;
        const cls = `den-shot-p${pn++}`;
        copy.classList.add(cls);
        pseudo.push(`.${cls}${which}{${p}content:${content};}`);
      }
    }
    return { copy, vals, svg, step };
  };

  const top = copyOf(root, null);
  if (!top) throw new Error("nothing to copy");
  const stack = [];
  const push = (el, into) => {
    const kids = [...(el.shadowRoot ?? el).childNodes];
    for (let i = kids.length - 1; i >= 0; i--) stack.push([kids[i], into]);
  };
  if (document.body && !skipEl(document.body)) push(root, top);
  let slice = performance.now();
  let n = 0;
  while (stack.length) {
    const [node, into] = stack.pop();
    if (node.nodeType === 3) {
      const t = document.createTextNode(node.nodeValue);
      if (into.step?.text && node.nodeValue.trim()) {
        const span = document.createElement("span");
        span.style.cssText = `position:relative;top:${into.step.text.dy}px;left:${into.step.text.dx}px;`;
        span.append(t);
        into.copy.append(span);
      } else into.copy.append(t);
      continue;
    }
    if (node.nodeType !== 1) continue;
    if (LEFT_OUT.has(node.tagName.toUpperCase()) || skipEl(node)) continue;
    const c = copyOf(node, into.vals);
    if (!c) continue;
    into.copy.append(c.copy);
    if (!c.svg && node.localName !== "textarea") push(node, c);
    // Every few milliseconds the page gets its turn (keys, paint).
    if (++n % 32 === 0 && performance.now() - slice > 8) {
      await nextTask();
      slice = performance.now();
    }
  }
  if (pseudo.length) {
    const st = document.createElement("style");
    st.textContent = pseudo.join("\n");
    top.copy.append(st);
  }
  await Promise.all([
    ...late.map(
      async ([copy, css]) => (copy.style.cssText = await inlineUrls(css)),
    ),
    ...imgs.map(async ([copy, src]) => {
      const u = await dataUrlOf(src);
      if (u) copy.setAttribute("src", u);
    }),
    pseudo.length
      ? inlineUrls(pseudo.join("\n")).then((t) => {
          top.copy.lastChild.textContent = t;
        })
      : null,
  ]);

  const svgEl = document.createElementNS(SVG_NS, "svg");
  svgEl.setAttribute("width", String(width));
  svgEl.setAttribute("height", String(height));
  svgEl.setAttribute("viewBox", `0 0 ${width} ${height}`);
  const fo = document.createElementNS(SVG_NS, "foreignObject");
  fo.setAttribute("x", "0");
  fo.setAttribute("y", "0");
  fo.setAttribute("width", "100%");
  fo.setAttribute("height", "100%");
  fo.append(top.copy);
  svgEl.append(fo);
  const url =
    "data:image/svg+xml;charset=utf-8," +
    encodeURIComponent(new XMLSerializer().serializeToString(svgEl));
  const img = await imageOf(url);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const g = canvas.getContext("2d");
  g.fillStyle = backgroundColor;
  g.fillRect(0, 0, width, height);
  g.drawImage(img, 0, 0, width, height);
  if (!canvas.width || !canvas.height) throw new Error("empty");
  return canvas;
}

/** The next task: the page's own work gets its turn. */
const nextTask = () => new Promise((ok) => setTimeout(ok, 0));

/** The page through html-to-image (the way before issue 469), or null. */
async function viaLibrary(seconds, skip) {
  let plan = [];
  try {
    const h2i = await Promise.race([loadLib(), timeout(seconds * 1000)]);
    const root = document.documentElement;
    const width = window.innerWidth;
    const height = window.innerHeight;
    const backgroundColor = getComputedStyle(document.body).backgroundColor;
    plan = scrollPlan(skip);
    // The window's scroll: the whole clone moves up (and left). Not
    // html-to-image's `style` option: its inset-block, copied from the
    // computed style, comes later in the attribute and wins over top.
    const x = window.scrollX;
    const y = window.scrollY;
    if (x || y)
      plan.push({
        el: root,
        css: `position:relative;top:${-y}px;left:${-x}px;bottom:auto;right:auto;`,
      });
    plan.forEach((step, i) => step.el.setAttribute(TAG, String(i)));
    const opts = {
      width,
      height,
      pixelRatio: 1,
      // The page's own fonts are already there: not fetched again.
      skipFonts: true,
      backgroundColor,
      filter: (n) => !(n.nodeType === 1 && (skip(n) || n.hasAttribute(BOX))),
    };
    let canvas;
    if (!plan.length) {
      canvas = await Promise.race([
        h2i.toCanvas(root, opts),
        timeout(seconds * 1000),
      ]);
    } else {
      const svg = await Promise.race([
        h2i.toSvg(root, opts),
        timeout(seconds * 1000),
      ]);
      for (const step of plan) step.el.removeAttribute(TAG);
      const img = await Promise.race([
        imageOf(applyPlan(svg, plan)),
        timeout(seconds * 1000),
      ]);
      canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const g = canvas.getContext("2d");
      g.fillStyle = backgroundColor;
      g.fillRect(0, 0, width, height);
      g.drawImage(img, 0, 0, width, height);
    }
    return canvas && canvas.width > 0 && canvas.height > 0 ? canvas : null;
  } catch {
    return null;
  } finally {
    for (const step of plan) step.el.removeAttribute(TAG);
  }
}

/** A copy of `canvas` with each mask (fractions of it) filled black. */
export function masked(canvas, masks) {
  const out = document.createElement("canvas");
  out.width = canvas.width;
  out.height = canvas.height;
  const g = out.getContext("2d");
  g.drawImage(canvas, 0, 0);
  // Black in every theme: a mask hides, it is not a theme colour.
  g.fillStyle = "black";
  for (const m of masks)
    g.fillRect(
      Math.floor(m.x * out.width),
      Math.floor(m.y * out.height),
      Math.ceil(m.w * out.width),
      Math.ceil(m.h * out.height),
    );
  return out;
}

/** A mask from two points (fractions), the right way round, clamped. */
export function rectOf(a, b) {
  const c = (v) => Math.min(1, Math.max(0, v));
  const x = c(Math.min(a.x, b.x));
  const y = c(Math.min(a.y, b.y));
  return {
    x,
    y,
    w: c(Math.max(a.x, b.x)) - x,
    h: c(Math.max(a.y, b.y)) - y,
  };
}

/** A mask from the keyboard form: percentages, clamped to the image. */
export function rectOfPercent(x, y, w, h) {
  const n = (v) => Math.min(100, Math.max(0, Number(v) || 0)) / 100;
  const r = { x: n(x), y: n(y), w: n(w), h: n(h) };
  r.w = Math.min(r.w, 1 - r.x);
  r.h = Math.min(r.h, 1 - r.y);
  return r;
}

export function toBlob(canvas) {
  return new Promise((ok) => canvas.toBlob(ok, "image/png"));
}

/**
 * After sending: the masked screenshot copied (where the browser allows
 * it) and saved as a file. Which of the two worked.
 */
export async function saveAndCopy(canvas, name = "report-screenshot.png") {
  const blob = await toBlob(canvas);
  const out = { copied: false, saved: false };
  if (!blob) return out;
  try {
    if (navigator.clipboard?.write && typeof ClipboardItem === "function") {
      await navigator.clipboard.write([
        new ClipboardItem({ "image/png": blob }),
      ]);
      out.copied = true;
    }
  } catch {
    /* not allowed here: the file is still saved */
  }
  try {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.hidden = true;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    out.saved = true;
  } catch {
    /* no download here */
  }
  return out;
}

/** An image (a Blob or a data: URL) back as a canvas, or null. */
export async function canvasOf(src) {
  let url = "";
  try {
    url = typeof src === "string" ? src : URL.createObjectURL(src);
    const img = new Image();
    await new Promise((ok, no) => {
      img.onload = ok;
      img.onerror = no;
      img.src = url;
    });
    const c = document.createElement("canvas");
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    c.getContext("2d").drawImage(img, 0, 0);
    return c.width && c.height ? c : null;
  } catch {
    return null;
  } finally {
    if (url && typeof src !== "string") URL.revokeObjectURL(url);
  }
}

/*
 * Finish later's screenshot stays in this browser (IndexedDB), keyed by
 * the draft's id, with its masks: the draft's text is on the product's server, the
 * picture never is. Storage off or full: the draft keeps its text only.
 */
const DB = "den-report";
const STORE = "shots";

function openDb() {
  return new Promise((ok, no) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => ok(r.result);
    r.onerror = () => no(r.error);
  });
}

async function inStore(mode, f) {
  const db = await openDb();
  try {
    return await new Promise((ok, no) => {
      const tx = db.transaction(STORE, mode);
      const req = f(tx.objectStore(STORE));
      tx.oncomplete = () => ok(req.result);
      tx.onerror = () => no(tx.error);
      tx.onabort = () => no(tx.error);
    });
  } finally {
    db.close();
  }
}

/** Keeps a draft's screenshot (the original) and its masks. */
export async function keepShot(id, canvas, masks, noShot) {
  try {
    const blob = await toBlob(canvas);
    if (!blob) return false;
    await inStore("readwrite", (s) =>
      s.put({ blob, masks, noShot: !!noShot }, id),
    );
    return true;
  } catch {
    return false;
  }
}

/** A kept screenshot: { canvas, masks, noShot }, or null. */
export async function loadShot(id) {
  try {
    const v = await inStore("readonly", (s) => s.get(id));
    if (!v || !v.blob) return null;
    const canvas = await canvasOf(v.blob);
    return canvas
      ? {
          canvas,
          masks: Array.isArray(v.masks) ? v.masks : [],
          noShot: !!v.noShot,
        }
      : null;
  } catch {
    return null;
  }
}

/** Forgets a draft's screenshot (sent or discarded). */
export async function dropShot(id) {
  try {
    await inStore("readwrite", (s) => s.delete(id));
  } catch {
    /* nothing kept */
  }
}
