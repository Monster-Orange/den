/* eslint-env browser */
// Live check for #171: Edge, Tests, Release, Logs and Environments show no English in es or ja.
// The page language is the person's setting, so setup switches it for the check and teardown puts the
// value it found back. It looks for the English the audit saw ("running", "none", "fetch failed") and a
// few other words a page draws itself, outside code and names.
export const issue = 171;
export const clauses = [
  "no English string on Edge, Tests, Release, Logs or Environments in es",
  "no English string on Edge, Tests, Release, Logs or Environments in ja",
];
export const matrix = { browsers: ["chromium", "webkit"], widths: [1280] };
export const timeoutMs = 240000;
const PAGES = ["/edge", "/test-runs", "/release", "/logs", "/environments"];
const LANGS = ["es", "ja"];

function english() {
  const main = document.querySelector("main") || document.body;
  const out = [];
  const walk = (n) => {
    for (const c of n.childNodes) {
      if (c.nodeType === 3) {
        const t = c.textContent;
        const m = t.match(
          /\b(running|stopped|none|fetch failed|Loading|Refresh|Not running|Healthy|Unhealthy|No (?:services|tests|logs))\b/,
        );
        if (m) out.push(`${m[0]} in "${t.trim().slice(0, 50)}"`);
      } else if (
        c.nodeType === 1 &&
        !["CODE", "PRE", "SCRIPT", "STYLE", "KBD", "SAMP"].includes(
          c.tagName,
        ) &&
        !c.hasAttribute("translate") &&
        // A service's own output (the log panes, a terminal) is the service's words, not the page's.
        !c.classList.contains("log-output") &&
        !c.classList.contains("xterm") &&
        c.getAttribute("aria-hidden") !== "true"
      ) {
        const s = getComputedStyle(c);
        if (s.display !== "none" && s.visibility !== "hidden") walk(c);
      }
    }
  };
  walk(main);
  return [...new Set(out)].slice(0, 8);
}

async function setLanguage(ctx, language) {
  return ctx.api("/api/settings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ language }),
  });
}

export async function setup(ctx) {
  const s = await ctx.api("/api/settings");
  return { was: s?.language ?? null };
}

export async function run(ctx, s) {
  const found = {};
  const lang = {};
  try {
    for (const l of LANGS) {
      await setLanguage(ctx, l);
      for (const p of PAGES) {
        await ctx.goto(ctx.page, p).catch(() => {});
        await ctx.page
          .waitForSelector("main", { timeout: 10000 })
          .catch(() => {});
        await ctx.sleep(1500);
        lang[l] = await ctx.page.evaluate(() => document.documentElement.lang);
        const hits = await ctx.page.evaluate(english);
        if (hits.length) found[`${l} ${p}`] = hits;
        await ctx.shot(
          `${l}${p.replace(/\//g, "-")}-${ctx.browser}-${ctx.width}`,
        );
      }
    }
  } finally {
    await setLanguage(ctx, s.was && s.was !== "en" ? s.was : null);
  }
  return { lang, found };
}

export function expect(cells) {
  return LANGS.map((l, i) => {
    const hits = cells.flatMap(({ cell, result }) =>
      Object.entries(result.found)
        .filter(([k]) => k.startsWith(`${l} `))
        .map(([k, v]) => `${cell.browser} ${k}: ${v.join("; ")}`),
    );
    return {
      clause: clauses[i],
      ok:
        cells.every(({ result }) => result.lang[l] === l) && hits.length === 0,
      detail: hits.length
        ? hits.join(" | ")
        : `${PAGES.join(" ")}: no English found (html lang ${cells.map(({ result }) => result.lang[l]).join(", ")})`,
      evidence: cells.flatMap(({ cell }) =>
        PAGES.map(
          (p) =>
            `${l}${p.replace(/\//g, "-")}-${cell.browser}-${cell.width}.png`,
        ),
      ),
    };
  });
}

export async function teardown(ctx, s) {
  if (s)
    await setLanguage(ctx, s.was && s.was !== "en" ? s.was : null).catch(
      () => {},
    );
}
