/**
 * FB (den#81): Report an issue's screenshot, and its mask.
 *
 * capture() takes the page as the person sees it, with any dialog, drawer
 * or menu that is open, before the form opens (the form itself is left
 * out). It uses html-to-image (MIT, served at /vendor/html-to-image.js,
 * the same version as Hub's), loaded the first time. It never throws: a
 * page that can't be captured, or that takes longer than `seconds`, gives
 * null, and the form offers to send without one.
 *
 * Masks are rectangles in fractions of the image (0..1), so they hold at
 * any size the image is shown at. masked() draws them in black onto a
 * copy: what is sent is the copy, never the original.
 *
 * The screenshot never goes to Den's server. GitHub's API can't attach an
 * image, so after sending it is saved as a file and copied, and the person
 * pastes it into the issue.
 */

const LIB = "/vendor/html-to-image.js";
let lib = null;

function loadLib() {
  if (lib) return lib;
  lib = new Promise((ok, no) => {
    if (window.htmlToImage) return ok(window.htmlToImage);
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

/**
 * The page as shown now, as a canvas the size of the window, or null.
 * `skip(el)`: elements to leave out (the form).
 */
export async function capture({ seconds = 15, skip = () => false } = {}) {
  try {
    const h2i = await Promise.race([loadLib(), timeout(seconds * 1000)]);
    const root = document.documentElement;
    const canvas = await Promise.race([
      h2i.toCanvas(root, {
        width: window.innerWidth,
        height: window.innerHeight,
        pixelRatio: 1,
        // The page's own fonts are already there: not fetched again.
        skipFonts: true,
        backgroundColor: getComputedStyle(document.body).backgroundColor,
        filter: (n) => !(n.nodeType === 1 && skip(n)),
      }),
      timeout(seconds * 1000),
    ]);
    return canvas && canvas.width > 0 && canvas.height > 0 ? canvas : null;
  } catch {
    return null;
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
  g.fillStyle = "rgb(0, 0, 0)";
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
 * the draft's id, with its masks: the draft's text is on Den's server, the
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
