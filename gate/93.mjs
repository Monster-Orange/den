/**
 * Live check for issue 93: a bell row opens on a click anywhere, with no
 * separate Open link. Two stub agents ask the person a long and a short
 * question (ctx.agent askHuman); a third finishes two turns, so a row
 * under Updates carries its ×2 and ⊘. Then, on the bed's page in each
 * browser and width, the same clauses as
 * tests/unit/server/bell-row.browser.test.ts.
 *
 * Names are this check's own (gate93-*). Teardown marks their items read,
 * removes the agents, and puts back the two settings it changes for the
 * run (turn-finished shown; the page's language, for es and ja).
 */
export const issue = 93;
export const clauses = [
  "a long question's row and a short one's both open on a click in the middle of the text",
  "no element named Open (Abrir, 開く) in any row, in en, es and ja",
  "Enter on the focused row opens it, with a focus ring and one accessible name",
  "the controls inside a row do not open the row",
];
export const matrix = { browsers: ["chromium", "webkit"], widths: [1280, 390] };
export const timeoutMs = 180000;

const WAIT_MS = 20000;
const LONG_Q =
  "Approve the direction for the tests? They run the checks each project already has, by layer and by environment, and nothing new.";
const SHORT_Q = "Ship it today?";
const OPEN_WORDS = /^(open|abrir|開く)$/i;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function json(ctx, path, init) {
  const r = await ctx.api(path, init);
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  return r.json();
}
const post = (ctx, path, body) =>
  json(ctx, path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
/**
 * A loaded page as the person uses it: the bell is there, and What's new,
 * if it opened over it, is closed by its × (the page then remembers it
 * as seen, in its own storage). Nothing on the bed changes.
 */
async function ready(p) {
  await p.waitForSelector("#den-bell");
  try {
    await p.locator("#cl-overlay.open").waitFor({ timeout: 2500 });
    await p.click("#cl-close-btn");
    await p
      .locator("#cl-overlay.open")
      .waitFor({ state: "detached", timeout: 5000 });
  } catch {
    /* not shown */
  }
}

const itemsOf = (groups) =>
  (groups ?? []).flatMap((g) =>
    (g.subjects ?? []).flatMap((s) => s.items ?? []),
  );
const mine = (a) => (subject) =>
  subject === `agent:${a.id}` ||
  subject === `agent:${a.name}` ||
  String(subject).endsWith(`:${a.name}`);

/** This agent's items, needs-you and Updates, polled until `ok`. */
async function itemsFor(ctx, a, ok = (l) => l.length > 0) {
  const end = Date.now() + WAIT_MS;
  for (;;) {
    const b = await json(ctx, "/api/notifications");
    const l = [...itemsOf(b.groups), ...itemsOf(b.updates?.groups)].filter(
      (n) => mine(a)(n.subject),
    );
    if (ok(l) || Date.now() > end) return l;
    await sleep(500);
  }
}

async function stub(ctx, state, role) {
  const name = `gate93-${role}-${state.tag}`;
  const ctl = await ctx.agent(name);
  const a = { name, id: ctl?.id ?? name, ctl };
  state.made.push(a);
  await ctl.sessionStart?.();
  return a;
}

export async function setup(ctx) {
  const settings = await json(ctx, "/api/settings");
  const state = {
    tag: Date.now().toString(36),
    made: [],
    finishedWasOn: settings?.bell_kinds?.finished === true,
    language: settings?.language ?? null,
  };
  if (!state.finishedWasOn)
    await post(ctx, "/api/settings", { bell_kinds: { finished: true } });
  const long = await stub(ctx, state, "long");
  await long.ctl.askHuman(LONG_Q);
  const short = await stub(ctx, state, "short");
  await short.ctl.askHuman(SHORT_Q);
  const turns = await stub(ctx, state, "turns");
  // Two turn ends: an unread item takes the next of its kind in, so the
  // first is read (as the person would have) and the second folds under ×2.
  for (let i = 0; i < 2; i++) {
    await turns.ctl.print(`Turn ${i + 1} done.`);
    await turns.ctl.stop();
    const got = await itemsFor(ctx, turns, (l) => l.some((n) => !n.read));
    if (i === 0)
      for (const n of got.filter((n) => !n.read))
        await post(ctx, "/api/notifications/read", { id: n.id });
  }
  state.links = {};
  for (const [k, a, n] of [
    ["long", long, 1],
    ["short", short, 1],
    ["turns", turns, 1],
  ]) {
    const l = await itemsFor(ctx, a, (l) => l.length >= n);
    state.links[k] = l.find((x) => x.link)?.link ?? null;
  }
  return state;
}

const START = "/services";
/** The cell's browser by name (ctx.browser: a name or a Browser). */
const browserName = (ctx) =>
  typeof ctx.browser === "string"
    ? ctx.browser
    : (ctx.browser?.browserType?.().name?.() ?? "browser");

async function openBell(ctx) {
  const p = ctx.page;
  await p.goto(new URL(START, ctx.url).href);
  await ready(p);
  await p.click("#den-bell");
  await p.locator("#den-bell-pop .den-bell-hd").waitFor();
  await p
    .locator("#den-bell-pop .den-bell-row, #den-bell-pop .den-bell-empty")
    .first()
    .waitFor();
}
const rowOf = (p, link) =>
  p.locator("#den-bell-pop .den-bell-row", {
    has: p.locator(`a[href="${link}"]`),
  });
const left = (p) => new URL(p.url()).pathname !== START;
async function leftWithin(p, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (left(p)) return true;
    await sleep(100);
  }
  return left(p);
}

export async function run(ctx, state) {
  const p = ctx.page;
  const seen = { width: ctx.width };

  // 1. A click in the middle of each question's text opens it.
  seen.click = {};
  for (const k of ["long", "short"]) {
    const link = state.links[k];
    if (!link) {
      seen.click[k] = { link: null };
      continue;
    }
    await openBell(ctx);
    const r = rowOf(p, link);
    const n = await r.count();
    let opened = false;
    if (n === 1) {
      // The question's text: its two-line span, or the link that holds it.
      const box = await r.locator(".den-bell-t, a").first().boundingBox();
      await p.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      opened = (await leftWithin(p)) && p.url().includes(link);
    }
    seen.click[k] = { link, rows: n, opened };
  }
  await ctx.shot?.(`bell-${browserName(ctx)}-${ctx.width}`);

  // 2. No Open in any row, in each language; then the language put back.
  seen.names = {};
  try {
    for (const lang of ["en", "es", "ja"]) {
      await post(ctx, "/api/settings", { language: lang });
      await openBell(ctx);
      const u = p.locator('#den-bell-pop [data-bell="updates"]');
      if (await u.count())
        if ((await u.getAttribute("aria-expanded")) !== "true") await u.click();
      const names = await p.$$eval(
        "#den-bell-pop .den-bell-row a, #den-bell-pop .den-bell-row button",
        (els) =>
          els.map((e) =>
            (e.getAttribute("aria-label") ?? e.textContent ?? "").trim(),
          ),
      );
      const texts = await p.$$eval("#den-bell-pop .den-bell-row", (els) =>
        els.map((e) => e.textContent ?? ""),
      );
      seen.names[lang] = {
        rows: texts.length,
        open: [
          ...names.filter((n) => OPEN_WORDS.test(n)),
          ...texts.filter((t) => /\b(Open|Abrir)\b|開く/.test(t)),
        ],
      };
    }
  } finally {
    await post(ctx, "/api/settings", { language: state.language });
  }

  // 3. Keyboard: Tab to the short question's link; ring, name, Enter.
  {
    const link = state.links.short;
    seen.keys = { link };
    if (link) {
      await p.goto(new URL(START, ctx.url).href);
      await ready(p);
      await p.focus("#den-bell");
      await p.keyboard.press("Enter");
      await p.locator("#den-bell-pop .den-bell-row").first().waitFor();
      const r = rowOf(p, link);
      seen.keys.links = await r.getByRole("link").count();
      seen.keys.name = await r
        .locator("a")
        .first()
        .evaluate((a) =>
          (a.getAttribute("aria-label") ?? a.textContent ?? "").trim(),
        );
      let at = "";
      for (let i = 0; i < 40 && at !== link; i++) {
        await p.keyboard.press("Tab");
        at = await p.evaluate(
          () => document.activeElement?.getAttribute("href") ?? "",
        );
      }
      seen.keys.reached = at === link;
      seen.keys.ring = await p.evaluate(() => {
        const a = document.activeElement;
        const cs = getComputedStyle(a);
        return {
          visible: a.matches(":focus-visible"),
          style: cs.outlineStyle,
          width: parseFloat(cs.outlineWidth),
        };
      });
      if (seen.keys.reached) {
        await p.keyboard.press("Enter");
        seen.keys.opened = (await leftWithin(p)) && p.url().includes(link);
      }
    }
  }

  // 4. ×N and ⊘ inside the turns row: by click and by Enter, the page stays.
  {
    const link = state.links.turns;
    seen.controls = { link, tried: [] };
    if (link) {
      await openBell(ctx);
      const u = p.locator('#den-bell-pop [data-bell="updates"]');
      if (
        (await u.count()) &&
        (await u.getAttribute("aria-expanded")) !== "true"
      )
        await u.click();
      const r = rowOf(p, link).first();
      const controls = await r.locator("button").count();
      seen.controls.count = controls;
      for (let i = 0; i < controls; i++) {
        for (const how of ["click", "Enter"]) {
          await openBell(ctx);
          const u2 = p.locator('#den-bell-pop [data-bell="updates"]');
          if (
            (await u2.count()) &&
            (await u2.getAttribute("aria-expanded")) !== "true"
          )
            await u2.click();
          const b = rowOf(p, link).first().locator("button").nth(i);
          const what = await b.getAttribute("data-bell");
          if (how === "click") await b.click();
          else {
            await b.focus();
            await p.keyboard.press("Enter");
          }
          // ⊘'s question is answered No: a check never stops a kind.
          const no = p.locator('#den-bell-pop [data-bell="ask-no"]');
          const stayed = !(await leftWithin(p, 1500));
          if (await no.count()) await no.click();
          seen.controls.tried.push({ what, how, stayed });
        }
      }
    }
  }
  return seen;
}

export async function teardown(ctx, state) {
  for (const a of state?.made ?? []) {
    try {
      for (const n of await itemsFor(ctx, a, () => true))
        if (!n.read) await post(ctx, "/api/notifications/read", { id: n.id });
    } catch {
      /* best effort */
    }
    try {
      await a.ctl.stop?.();
      await (a.ctl.remove ?? a.ctl.dispose ?? a.ctl.close)?.call(a.ctl);
    } catch {
      /* best effort */
    }
  }
  if (!state) return;
  await post(ctx, "/api/settings", { language: state.language }).catch(
    () => {},
  );
  if (!state.finishedWasOn)
    await post(ctx, "/api/settings", { bell_kinds: { finished: null } }).catch(
      () => {},
    );
}

function rows(s, cell) {
  const tag = cell ? `${cell.browser ?? ""}-${cell.width ?? ""}` : "";
  const c = s?.click ?? {};
  const k = s?.keys ?? {};
  const t = s?.controls ?? {};
  const names = s?.names ?? {};
  return [
    {
      clause: clauses[0],
      ok: !!c.long?.opened && !!c.short?.opened,
      detail: `${tag} ${JSON.stringify(c)}`,
    },
    {
      clause: clauses[1],
      ok:
        ["en", "es", "ja"].every((l) => names[l]?.rows > 0) &&
        ["en", "es", "ja"].every((l) => names[l].open.length === 0),
      detail: `${tag} ${JSON.stringify(names)}`,
    },
    {
      clause: clauses[2],
      ok:
        k.links === 1 &&
        String(k.name ?? "").includes(SHORT_Q) &&
        !!k.reached &&
        k.ring?.visible === true &&
        k.ring?.style !== "none" &&
        k.ring?.width > 0 &&
        !!k.opened,
      detail: `${tag} ${JSON.stringify(k)}`,
    },
    t.count
      ? {
          clause: clauses[3],
          ok: t.tried.length > 0 && t.tried.every((x) => x.stayed),
          detail: `${tag} ${JSON.stringify(t)}`,
        }
      : { clause: clauses[3], ok: null, skip: "needs-row-controls" },
  ];
}

export function expect(cells) {
  const list = Array.isArray(cells) ? cells : [{ result: cells }];
  const per = list.map((c) => rows(c?.result, c?.cell));
  const evidence = list
    .map((c) => c?.cell && `bell-${c.cell.browser}-${c.cell.width}`)
    .filter(Boolean);
  return clauses.map((clause, i) => {
    const got = per.map((r) => r[i]);
    if (got.every((r) => r.ok === null)) return got[0];
    const ran = got.filter((r) => r.ok !== null);
    return {
      clause,
      ok: ran.every((r) => r.ok === true),
      detail: ran.map((r) => r.detail).join(" | "),
      ...(i === 0 && evidence.length ? { evidence } : {}),
    };
  });
}
