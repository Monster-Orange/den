/**
 * Issue 774: how many agents need the person, in the tab's title and on
 * its icon, so a tab behind others still says it. The count goes in
 * front of the whole title: "(2) Den · Agents". On the 16 px icon the
 * badge is a dot with the digit, "9+" from ten; the title carries the
 * exact count. Zero shows nothing: the title and the theme's icon as
 * they were.
 *
 * The page (shell.js) and the theme (appearance.js) set the title and
 * the icon; this follows them: a new title gets the count again, and a
 * new theme icon is the one the badge is drawn on.
 */

const PREFIX = /^\(\d+\)\s/;

/** `title` with the count `n` in front (none at zero). */
export function titleWithCount(title, n) {
  const base = String(title ?? "").replace(PREFIX, "");
  return n > 0 ? `(${n}) ${base}` : base;
}

/** The icon badge's text: "" at zero, the digit, "9+" from ten. */
export function badgeText(n) {
  if (!(n > 0)) return "";
  return n > 9 ? "9+" : String(Math.floor(n));
}

/**
 * The theme's colors for the badge, from its tokens on the page: the
 * accent dot, ringed in the page's background, the digit in the color
 * that reads on the accent. A canvas takes no CSS variables, so they are
 * read once per drawing, with the theme's sans for the digit. Empty when
 * the page has no theme yet.
 */
export function badgeColors(doc) {
  const cs = doc.defaultView?.getComputedStyle?.(doc.documentElement);
  const v = (name) => (cs ? cs.getPropertyValue(name).trim() : "");
  return {
    dot: v("--accent"),
    ring: v("--bg"),
    digit: v("--on-accent"),
    sans: v("--sans"),
  };
}

/**
 * The badge drawn on a 64 px icon (the mock's, scaled with it): a dot in
 * the theme's accent top right, ringed in its background, with the digit
 * in the color that reads on the accent. A color the theme doesn't give
 * leaves the canvas's own.
 */
function drawBadge(g, text, colors) {
  g.beginPath();
  g.arc(46, 18, 17, 0, Math.PI * 2);
  if (colors.dot) g.fillStyle = colors.dot;
  g.fill();
  g.lineWidth = 3;
  if (colors.ring) g.strokeStyle = colors.ring;
  g.stroke();
  if (colors.digit) g.fillStyle = colors.digit;
  g.textAlign = "center";
  g.font = `700 ${text.length > 1 ? 17 : 22}px ${colors.sans || "sans-serif"}`;
  g.fillText(text, 46, text.length > 1 ? 24.1 : 25.9);
}

/** The tab's count painter for this page: show(n). */
export function tabCount(win = window) {
  const doc = win.document;
  let n = 0;
  /** The theme's icon (the badge is drawn on it), by the link it is on. */
  let base = null;
  let drawn = null;
  let drawing = 0;

  const link = () =>
    doc.getElementById("den-favicon") || doc.querySelector('link[rel~="icon"]');

  const paintTitle = () => {
    const want = titleWithCount(doc.title, n);
    if (doc.title !== want) doc.title = want;
  };

  const paintIcon = () => {
    const l = link();
    if (!l) return;
    const href = l.getAttribute("href");
    if (href && href !== drawn) base = href;
    const text = badgeText(n);
    if (!text) {
      drawn = null;
      if (base && href !== base) l.setAttribute("href", base);
      return;
    }
    if (!base) return;
    const mine = ++drawing;
    const img = new win.Image();
    img.onload = () => {
      if (mine !== drawing) return;
      try {
        const c = doc.createElement("canvas");
        c.width = 64;
        c.height = 64;
        const g = c.getContext("2d");
        if (!g) return;
        g.drawImage(img, 0, 0, 64, 64);
        drawBadge(g, text, badgeColors(doc));
        drawn = c.toDataURL("image/png");
        l.setAttribute("href", drawn);
      } catch {
        /* the title still has the count */
      }
    };
    img.src = base;
  };

  // The page or the theme changed the title or the icon: follow it.
  try {
    const Obs = win.MutationObserver;
    if (typeof Obs === "function" && doc.head)
      new Obs((records) => {
        if (!n && !drawn) return;
        const iconMoved = records.some(
          (r) =>
            r.type === "attributes" &&
            r.target.getAttribute?.("href") !== drawn,
        );
        paintTitle();
        if (iconMoved || records.some((r) => r.type === "childList"))
          if (link()?.getAttribute("href") !== drawn) paintIcon();
      }).observe(doc.head, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
        attributeFilter: ["href"],
      });
  } catch {
    /* no observer: the next count paints again */
  }

  return {
    show(count) {
      const next = Math.max(0, Number(count) || 0);
      const was = n;
      n = next;
      paintTitle();
      if (badgeText(was) !== badgeText(next) || (next && !drawn)) paintIcon();
    },
  };
}
