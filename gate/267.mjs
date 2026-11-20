/* eslint-env browser */
// Live check for issue 267: Settings › Hub, its own section to add, change and clear Hub's address, with no
// file to edit and no terminal. A person types the address in the page and presses Save; Den writes it to
// the person's config and restarts itself, then says where it stands. Change and Clear work the same way.
// The check runs the writes only on a bed with no Hub address (the issue's case), with invented addresses
// under .invalid, which never resolve: no Hub is ever reached and no token is made. Teardown clears the
// address and restarts Den if the bed has one the check left. The page's language is put back in a finally.
// The server agent's held write hub_connect is asked only with an address its check refuses, so nothing
// waits for anyone's Allow. Connecting (a token from Hub) needs a Hub on the bed, and the person's sign-in.
export const issue = 267;
export const clauses = [
  "Settings › Hub is its own section, next to Server and Access, and Hub's notification rows are in it",
  "Settings › Hub shows Hub's address (empty when not connected), with the same check as hubUrlProblem inline",
  "Save applies it: Den writes it to the user's config, restarts itself (the working pop-up, then back), and says where it stands",
  "change and clear work the same way: each restarts Den, and clearing leaves no Hub",
  'the section says what Hub is and what agents get from it, with a "What is Hub?" link to docs/hub.md',
  "a Den with no Hub shows the section with one sentence on why you'd add it, and the address field",
  "the section's words are in en, es and ja",
  "docs/hub.md says what Hub is, how to add it in Settings, what changes for agents and people, how to disconnect, and troubleshooting; README and reference.md link it",
  "the server agent's held write hub_connect runs the same address check, and its instructions say Hub can be added this way",
  "connected: the row says so, offers Disconnect, says agents lose Hub's tools after their next restart, and an agent sees Hub's tools",
  "a server agent connects a Den to Hub on a person's Allow",
];
export const matrix = { browsers: ["chromium"], widths: [1280] };
export const timeoutMs = 420000;

const BAD = "http://gate-267.invalid";
const A = "https://gate-267-a.invalid";
const B = "https://gate-267-b.invalid";
const LANGS = ["en", "es", "ja"];
/** The engine's folder in the bed: its dependency named <scope>/den, from the bed's package.json. */
function engineDir(ctx) {
  try {
    const p = JSON.parse(ctx.readBed("package.json") ?? "{}");
    const name = Object.keys({ ...p.dependencies, ...p.devDependencies }).find(
      (n) => /^@[^/]+\/den$/.test(n),
    );
    return name ? `node_modules/${name}` : null;
  } catch {
    return null;
  }
}
const USER_YML = "config/local/user.yml";
const RESTART_MS = 120000;

const json = (body) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});
async function get(ctx, path) {
  try {
    const r = await ctx.fetch(path);
    return r.status === 200 ? r.body : null;
  } catch {
    return null;
  }
}
const info = async (ctx) => {
  const i = await get(ctx, "/api/server-info");
  return i ? { pid: i.pid ?? null, startedAt: i.startedAt ?? null } : null;
};
const sameServer = (a, b) =>
  !!a && !!b && a.pid === b.pid && a.startedAt === b.startedAt;
/** hub.url in a user.yml's text, or null: the indented url under the top-level hub block. */
function hubUrlIn(yml) {
  const lines = String(yml ?? "").split("\n");
  const at = lines.findIndex((l) => /^hub:\s*$/.test(l));
  if (at < 0) return null;
  for (const l of lines.slice(at + 1)) {
    if (/^\S/.test(l)) break;
    const m = /^\s+url:\s*["']?([^"'\s]+)/.exec(l);
    if (m) return m[1];
  }
  return null;
}
const errorOf = (b) => (typeof b === "string" ? b.trim() : (b?.error ?? null));

/**
 * Everything the check does in the page goes through this one function, run in the page: read the
 * Hub section, type into its address field, or press one of its buttons.
 */
function inPage({ op, arg }) {
  const sec = document.querySelector('section[data-cat="hub"]');
  const q = (s) => sec?.querySelector(s) ?? null;
  const text = (e) => (e?.textContent ?? "").replace(/\s+/g, " ").trim();
  const input = () => q("#hub-addr") || q("#hub-url");
  const save = () => q('[data-hub-action="save-url"]');
  if (op === "type") {
    const i = input();
    if (!i) return null;
    i.value = arg;
    i.dispatchEvent(new Event("input", { bubbles: true }));
    const p = q("[data-hub-addr-problem]");
    return {
      problem: p && !p.hidden ? text(p) : null,
      saveDisabled: save()?.disabled ?? null,
    };
  }
  if (op === "press") {
    const b = q(`[data-hub-action="${arg}"]`);
    if (!b) return false;
    // The working pop-up is <den-busy>, added while it works: watch for it from the press on.
    window.__gate267busy = false;
    const seen = () =>
      document.querySelector("den-busy") && (window.__gate267busy = true);
    window.__gate267obs?.disconnect();
    window.__gate267obs = new MutationObserver(seen);
    window.__gate267obs.observe(document.body, {
      childList: true,
      subtree: true,
    });
    b.click();
    seen();
    return true;
  }
  if (op === "busy") return window.__gate267busy === true;
  // op "read": the section as it stands.
  const flash = q("[data-hub-flash]");
  const desc = sec?.querySelector(":scope > p");
  return {
    lang: document.documentElement.lang || null,
    nav: [...document.querySelectorAll(".set-ni[data-cat]")].map(
      (a) => a.dataset.cat,
    ),
    section: !!sec,
    title: text(q("h2")),
    description: text(desc),
    links: [...(sec?.querySelectorAll("a[href]") ?? [])].map((a) => ({
      href: a.getAttribute("href"),
      text: text(a),
    })),
    rows: [...(sec?.querySelectorAll(".set-row[data-setting]") ?? [])].map(
      (r) => r.dataset.setting,
    ),
    agentsHub: text(
      q('.set-row[data-setting="agents.hub"] .d') ||
        q('.set-row[data-setting="agents.hub"]'),
    ),
    address: input()?.value ?? null,
    connect: text(q('[data-hub-action="connect"]')) || null,
    disconnect: !!q('[data-hub-action="disconnect"]'),
    saveLabel: text(save()) || null,
    clear: !!q('[data-hub-action="clear-url"]'),
    empty: text(q("[data-hub-empty]")) || null,
    connectNote: text(q("[data-hub-connect-does]")) || null,
    state: q("[data-hub-state]")?.getAttribute("data-hub-state") ?? null,
    flash: flash
      ? { ok: flash.getAttribute("data-hub-flash"), text: text(flash) }
      : null,
    error: text(q(".rt-err:not([hidden])")) || null,
  };
}
const page = (ctx, op, arg) => ctx.page.evaluate(inPage, { op, arg });

async function openHub(ctx) {
  await ctx.goto(ctx.page, "/settings#hub");
  await ctx.page
    .waitForSelector('section[data-cat="hub"] .set-row', { timeout: 20000 })
    .catch(() => {});
  // The Hub row draws itself after GET /api/hub answers.
  await ctx.until(async () => {
    const r = await page(ctx, "read");
    return r?.address !== null || r?.state !== null;
  }, 10000);
  return page(ctx, "read");
}

/**
 * Type `url` (null: press Clear), press it, and wait for Den to come back as a new server and the row to
 * say so. What it saw on the way.
 */
async function apply(ctx, url, shot) {
  const before = await info(ctx);
  let typed = null;
  if (url !== null) typed = await page(ctx, "type", url);
  const pressed = await page(
    ctx,
    "press",
    url === null ? "clear-url" : "save-url",
  );
  const restartMs = await ctx.until(async () => {
    const now = await info(ctx);
    return !!now && !sameServer(before, now);
  }, RESTART_MS);
  const flashMs = await ctx.until(async () => {
    const r = await page(ctx, "read").catch(() => null);
    return !!r?.flash;
  }, 30000);
  const busy = await page(ctx, "busy").catch(() => false);
  const row = await page(ctx, "read").catch(() => null);
  await ctx.shot(shot);
  return {
    typed,
    pressed,
    restartMs,
    flashMs,
    busy,
    row,
    hub: await get(ctx, "/api/hub"),
    userUrl: hubUrlIn(ctx.readBed(USER_YML)),
  };
}

async function setLanguage(ctx, language) {
  const r = await ctx.fetch("/api/settings", json({ language }));
  if (r.status !== 200)
    throw new Error(`language ${language}: HTTP ${r.status}`);
}

export async function setup(ctx) {
  const s = await get(ctx, "/api/settings");
  const hub = await get(ctx, "/api/hub");
  return {
    lang: s?.language ?? null,
    hub,
    userUrl: hubUrlIn(ctx.readBed(USER_YML)),
    // Writes only where the issue says: a Den with no Hub address at all.
    writable: !!hub && hub.configured === false,
  };
}

export async function run(ctx, s) {
  const r = { ...s };
  r.en = await openHub(ctx);
  await ctx.shot("hub-section-en");

  // The words, in each language, on the section as the bed has it now; the language put back after.
  r.words = {};
  try {
    for (const l of LANGS) {
      await setLanguage(ctx, l);
      r.words[l] = await openHub(ctx);
      await ctx.shot(`hub-section-${l}`);
    }
  } catch (e) {
    r.words.error = String(e?.message ?? e);
  } finally {
    await setLanguage(ctx, s.lang).catch(() => {});
  }
  await openHub(ctx);

  // The inline check: as typed, before any Save.
  r.inline = {
    bad: await page(ctx, "type", BAD),
    good: await page(ctx, "type", A),
  };
  // The server's own check refuses the same address (nothing is written).
  const bad = await ctx.fetch("/api/settings", json({ hub_url: BAD }));
  r.serverBad = { status: bad.status, error: errorOf(bad.body) };

  // hub_connect, asked with an address its check refuses: nothing waits for an Allow.
  const held = await ctx.fetch(
    "/api/approvals",
    json({
      action: "hub_connect",
      args: { url: BAD },
      note: "Issue 267 live check: an address the check refuses; nothing to Allow.",
    }),
  );
  r.held = {
    status: held.status,
    code: held.body?.code ?? null,
    error: held.body?.error ?? null,
    id: held.body?.id ?? null,
  };
  const engine = engineDir(ctx);
  const read = (rel) => (engine ? ctx.readBed(`${engine}/${rel}`) : null);
  r.engine = engine;
  r.serverMd = read("src/shared/agents/server-pack/server.md");
  r.docs = {
    hub: read("docs/hub.md"),
    readme: read("README.md"),
    reference: read("docs/reference.md"),
  };

  if (!s.writable) return r;
  await openHub(ctx);
  r.save = await apply(ctx, A, "hub-saved");
  r.change = await apply(ctx, B, "hub-changed");
  r.clear = await apply(ctx, null, "hub-cleared");
  return r;
}

export async function teardown(ctx, s) {
  if (!s?.writable) return;
  if (hubUrlIn(ctx.readBed(USER_YML)) === null) return;
  // The check left an address: clear it, and restart Den so it reads none.
  const before = await info(ctx);
  await ctx.fetch("/api/settings", json({ hub_url: null })).catch(() => {});
  await ctx.fetch("/api/web/restart", json({})).catch(() => {});
  await ctx.until(async () => {
    const now = await info(ctx);
    return !!now && !sameServer(before, now);
  }, RESTART_MS);
}

const ordered = (rows) =>
  rows.sort((a, b) => clauses.indexOf(a.clause) - clauses.indexOf(b.clause));

export function expect(cells) {
  const r = cells[0]?.result ?? {};
  const en = r.en ?? {};
  const rows = [];
  const row = (i, ok, detail, evidence) =>
    rows.push({
      clause: clauses[i],
      ok,
      detail,
      ...(evidence ? { evidence: evidence.map((n) => `${n}.png`) } : {}),
    });
  const skip = (i, why, detail) =>
    rows.push({ clause: clauses[i], ok: null, skip: why, detail });

  // 0. Its own section, near Server and Access, holding Hub's bell rows.
  const nav = en.nav ?? [];
  const at = (c) => nav.indexOf(c);
  const near =
    at("hub") >= 0 &&
    at("access") >= 0 &&
    at("server") >= 0 &&
    // Settings' own order: Hub just before Access, in the run that ends with Server.
    at("hub") < at("access") &&
    at("access") < at("server") &&
    at("access") - at("hub") <= 3;
  const bellRows = [
    "notifications.hub",
    "notifications.pick",
    "notifications.shared",
  ];
  const hasBell = bellRows.every((x) => (en.rows ?? []).includes(x));
  row(
    0,
    !!en.section && near && hasBell,
    `nav ${nav.join(" › ")}; Hub's rows ${JSON.stringify(en.rows)}`,
    ["hub-section-en"],
  );

  // 1. The address, empty with no Hub, and the check as typed (and the server's, the same rule).
  const noHub = r.hub?.configured === false;
  const inl = r.inline ?? {};
  const inlineOk =
    !!inl.bad?.problem &&
    inl.bad?.saveDisabled === true &&
    inl.good?.problem === null &&
    inl.good?.saveDisabled === false;
  row(
    1,
    en.address !== null &&
      (!noHub || en.address === "") &&
      inlineOk &&
      r.serverBad?.status === 400,
    `address field "${en.address}" (bed has ${noHub ? "no Hub" : `Hub ${r.hub?.url}`}); typed ${BAD}: "${inl.bad?.problem}", Save disabled ${inl.bad?.saveDisabled}; typed ${A}: problem ${inl.good?.problem}, Save disabled ${inl.good?.saveDisabled}; the server refuses ${BAD}: ${r.serverBad?.status} "${r.serverBad?.error}"`,
  );

  // 2, 3. Save, change and clear: only on a bed with no Hub.
  const step = (x, want) =>
    !!x &&
    x.pressed === true &&
    x.restartMs !== null &&
    x.flashMs !== null &&
    x.row?.flash?.ok === "ok" &&
    want(x);
  const said = (x) =>
    `pressed ${x?.pressed}, Den back as a new server after ${x?.restartMs} ms, working pop-up ${x?.busy}, row "${x?.row?.flash?.text}" (${x?.row?.flash?.ok}), state ${x?.row?.state ?? "not connected"}, Connect ${x?.row?.connect ? "offered" : "not offered"}; /api/hub ${x?.hub?.configured ? x?.hub?.url : "no Hub"}; user.yml hub.url ${x?.userUrl}`;
  if (!r.writable) {
    const why = `the bed has a Hub address already (${r.hub?.url ?? "unknown"}); the check writes only on a Den with none`;
    skip(2, "needs-no-hub-address", why);
    skip(3, "needs-no-hub-address", why);
  } else {
    const atUrl = (x, url) =>
      x?.hub?.url === url && x?.userUrl === url && !!x?.row?.connect;
    row(
      2,
      step(r.save, (x) => atUrl(x, A)) && r.save.busy === true,
      said(r.save),
      ["hub-saved"],
    );
    row(
      3,
      step(r.change, (x) => atUrl(x, B)) &&
        step(
          r.clear,
          (x) =>
            x.hub?.configured === false &&
            x.userUrl === null &&
            x.row?.address === "",
        ),
      `change: ${said(r.change)}. Clear: ${said(r.clear)}`,
      ["hub-changed", "hub-cleared"],
    );
  }

  // 4. What Hub is, what agents get, and a link to the doc.
  const docLink = (en.links ?? []).find((l) =>
    /hub\.md(#|$)/.test(l.href ?? ""),
  );
  row(
    4,
    /Hub/.test(en.description ?? "") &&
      /agent/i.test(en.agentsHub ?? "") &&
      /tool/i.test(en.agentsHub ?? "") &&
      !!docLink,
    `section: "${en.description}"; agents.hub: "${en.agentsHub}"; doc link ${docLink ? docLink.href : `none (links ${JSON.stringify(en.links)})`}`,
  );

  // 5. The empty state.
  if (!noHub)
    skip(
      5,
      "needs-no-hub-address",
      `the bed has a Hub address (${r.hub?.url})`,
    );
  else
    row(
      5,
      !!en.empty && en.address === "" && !!en.connect,
      `empty: "${en.empty}"; address field "${en.address}"; Connect "${en.connect}"`,
    );

  // 6. en, es, ja: the section's own words differ from English, and the page says its language.
  const w = r.words ?? {};
  const keys = [
    "description",
    "connectNote",
    "saveLabel",
    ...(noHub ? ["empty"] : []),
  ];
  const langOk = LANGS.every(
    (l) =>
      w[l]?.lang === l &&
      keys.every((k) => !!w[l]?.[k] && (l === "en" || w[l][k] !== w.en?.[k])),
  );
  row(
    6,
    !w.error && langOk,
    w.error
      ? `language switch: ${w.error}`
      : LANGS.map(
          (l) =>
            `${l} (html ${w[l]?.lang}): ${keys.map((k) => `${k} "${w[l]?.[k]}"`).join(", ")}`,
        ).join("; "),
    LANGS.map((l) => `hub-section-${l}`),
  );

  // 7. The doc, and the links to it.
  const d = r.docs ?? {};
  const hd = d.hub ?? "";
  const parts = {
    whatItIs: /^# .*Hub[\s\S]*?\n\n[^\n#]*Hub is /m.test(hd),
    addInSettings: /^## Connect/m.test(hd) && /Settings › Hub/.test(hd),
    forAgents: /^## What agents get/m.test(hd),
    forPeople: /^## (Notifications from Hub|What you get)/m.test(hd),
    disconnect: /^#+ Disconnect/m.test(hd),
    troubleshooting: /^## Troubleshooting/m.test(hd),
    readme: /\]\(docs\/hub\.md\)/.test(d.readme ?? ""),
    reference: /\]\((\.\/)?hub\.md\)/.test(d.reference ?? ""),
  };
  if (d.hub === null || d.hub === undefined)
    skip(
      7,
      "needs-engine-files",
      r.engine
        ? `ctx.readBed("${r.engine}/docs/hub.md") gave nothing`
        : "the bed's package.json names no <scope>/den dependency",
    );
  else
    row(
      7,
      Object.values(parts).every(Boolean),
      Object.entries(parts)
        .map(([k, v]) => `${k} ${v}`)
        .join(", "),
    );

  // 8. hub_connect: the same check, refused before anything waits; the server agent's instructions.
  const h = r.held ?? {};
  const md = r.serverMd ?? "";
  if (h.code === "approvals_off")
    skip(
      8,
      "needs-held-writes-on",
      "the bed turned held writes off (mcp.approvals: false)",
    );
  else
    row(
      8,
      h.status === 400 &&
        h.code === "invalid_args" &&
        !h.id &&
        !!h.error &&
        h.error === r.serverBad?.error &&
        /hub_connect/.test(md) &&
        /Hub's address/.test(md),
      `hub_connect with ${BAD}: ${h.status} ${h.code} "${h.error}" (Settings' Save: "${r.serverBad?.error}"); server agent's instructions name hub_connect: ${/hub_connect/.test(md)}`,
    );

  // 9, 10. A Hub to connect to, and a person.
  skip(
    9,
    "needs-hub",
    "Connect needs a Hub that signs a person in and gives this install a token; the bed has none",
  );
  skip(
    10,
    "person",
    "the server agent's hub_connect runs only on the person's own Allow, then the person's Connect",
  );
  return ordered(rows);
}
