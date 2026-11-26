/**
 * den-ui: the Report form's screenshot, and its mask.
 *
 * capture() takes the page as the person sees it, with any dialog, drawer
 * or menu that is open, before the form opens (the form itself is left
 * out). It uses html-to-image (MIT; the product serves it and names its
 * URL with configureShots({ library })), loaded the first time. It never throws: a
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

function timeout(ms) {
  return new Promise((_, no) =>
    setTimeout(() => no(new Error("capture timed out")), ms),
  );
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
  // What skip() leaves out, with everything inside it (issue 1499: the
  // Report form is open while the page is taken; nothing in it is read or
  // touched).
  const skipped = [];
  for (const el of document.body ? document.body.querySelectorAll("*") : []) {
    if (el === se || skipped.some((r) => r.contains(el))) continue;
    if (skip(el)) {
      skipped.push(el);
      continue;
    }
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
    if (css || m.text)
      plan.push({
        el,
        css,
        text: m.text,
        still: m.sticky && !m.dx && !m.dy && !m.clip && !m.text,
      });
  }
  // Issue 1341: sticky parts sticky hasn't moved (the rail's foot in a
  // rail that fits) need nothing when nothing else moved either: the
  // plain capture, as before they were sticky.
  return plan.every((x) => x.still) ? [] : plan.map(({ still, ...x }) => x);
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
 * `skip(el)`: elements to leave out (the form).
 */
export async function capture({ seconds = 15, skip = () => false } = {}) {
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
      filter: (n) => !(n.nodeType === 1 && skip(n)),
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
