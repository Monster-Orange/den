const PREFIX = /^\(\d+\)\s/;

export function titleWithCount(title, n) {
  const base = String(title ?? "").replace(PREFIX, "");
  return n > 0 ? `(${n}) ${base}` : base;
}

export function badgeText(n) {
  if (!(n > 0)) return "";
  return n > 9 ? "9+" : String(Math.floor(n));
}

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

export function tabCount(win = window) {
  const doc = win.document;
  let n = 0;
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
