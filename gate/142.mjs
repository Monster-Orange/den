/**
 * Live check for issue 142: the bell's badge counts only what needs the
 * person, per the 11-16 audit's fix list. Driven through the bed's stub
 * agents (ctx.agent: their real hook events into Den), read back through
 * GET /api/notifications and the page's badge.
 *
 * Unit tests for the same paths: tests/unit/server/bell-needs-you.test.ts,
 * bell-142-turn-end.test.ts and bell-142.integration.test.ts.
 * Names are this check's own (gate142-*); teardown marks their items read,
 * removes the agents, and puts the one setting it turns on back.
 */
export const issue = 142;
export const clauses = [
  "a permission prompt counts in the badge",
  "an agent that called ask_human, or ended its turn with a question to the person, counts",
  "a plain idle agent goes to Updates (no badge)",
  "Den's Allow-the-update ask counts",
  "opening the agent removes its Updates items and the count drops",
];
export const matrix = { browsers: ["chromium"], widths: [1280] };
export const timeoutMs = 180000;

const WAIT_MS = 20000;
const QUESTION = "Shall I merge the branch now?";

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

/** Every item in a list of groups (groups → subjects → items). */
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

/** An item or a waiting row is this agent's: by its id, or by its name. */
const mine = (a) => (subject) =>
  subject === `agent:${a.id}` ||
  subject === `agent:${a.name}` ||
  String(subject).endsWith(`:${a.name}`);

/** The bell as Den answers it, reduced to this agent. */
async function bellFor(ctx, a) {
  const b = await json(ctx, "/api/notifications");
  const is = mine(a);
  const needs = itemsOf(b.groups).filter((n) => is(n.subject));
  const updates = itemsOf(b.updates?.groups).filter((n) => is(n.subject));
  const waiting = (b.waiting ?? []).filter((w) => is(`agent:${w.agent}`));
  return {
    unread: b.unread ?? 0,
    updatesCount: b.updates?.count ?? 0,
    needs,
    updates,
    waiting,
    all: b,
  };
}

/** Polls the bell until `ok(view)` or WAIT_MS; returns the last view. */
async function until(ctx, a, ok) {
  const end = Date.now() + WAIT_MS;
  let v = await bellFor(ctx, a);
  while (!ok(v) && Date.now() < end) {
    await sleep(500);
    v = await bellFor(ctx, a);
  }
  return v;
}

/** The page's badge after a reload ("" when hidden). */
async function pageBadge(ctx) {
  if (!ctx.page) return null;
  await ctx.page.goto(new URL("/services", ctx.url).href);
  await ready(ctx.page);
  // The bell loads its count once on start; give it that one answer.
  await ctx.page
    .waitForFunction(
      () => document.querySelector("#den-bell")?.dataset.wired,
      null,
      {
        timeout: WAIT_MS,
      },
    )
    .catch(() => {});
  await sleep(1500);
  return ctx.page.evaluate(() => {
    const b = document.querySelector(".den-bell-n");
    return !b || b.hidden ? "" : (b.textContent ?? "").trim();
  });
}

/**
 * A turn's end as Claude Code sends it: the answer on screen, then its
 * Stop hook with the answer as `last_assistant_message` (the hook tells
 * Den the question it ended on). Not `ctl.stop()`: that stops the agent.
 */
async function turnEnd(a, answer) {
  await a.ctl.print(answer);
  await a.ctl.hook("Stop", {
    stop_hook_active: false,
    last_assistant_message: answer,
  });
}

/** A stub agent under this check's own name, recorded for teardown. */
async function stub(ctx, state, role) {
  const name = `gate142-${role}-${state.tag}`;
  const ctl = await ctx.agent(name);
  const a = { name, id: ctl?.id ?? name, ctl };
  state.made.push(a);
  // A handle creates nothing: start the agent and wait until it runs,
  // so its session (and its file) exist before sessionStart.
  ctl.start("tester");
  a.runMs = await ctl.running(20000);
  await ctl.sessionStart?.();
  return a;
}

export async function setup(ctx) {
  const settings = await json(ctx, "/api/settings");
  return {
    tag: Date.now().toString(36),
    made: [],
    // Turn-finished items are off by default; clause 3 needs them shown.
    finishedWasOn: settings?.bell_kinds?.finished === true,
  };
}

export async function run(ctx, state) {
  const seen = {};
  if (!state.finishedWasOn)
    await post(ctx, "/api/settings", { bell_kinds: { finished: true } });

  // 1. A permission prompt: needs you, counted.
  {
    const before = (await json(ctx, "/api/notifications")).unread ?? 0;
    const a = await stub(ctx, state, "perm");
    await a.ctl.permissionRequest();
    const v = await until(ctx, a, (v) => v.needs.some((n) => !n.read));
    seen.permission = {
      before,
      after: v.unread,
      needs: v.needs.length,
      unreadNeeds: v.needs.filter((n) => !n.read).length,
      waiting: v.waiting.map((w) => w.why),
      badge: await pageBadge(ctx),
      apiUnread: (await bellFor(ctx, a)).unread,
    };
  }

  // 2a. ask_human: needs you, counted.
  {
    const a = await stub(ctx, state, "ask");
    await a.ctl.askHuman(QUESTION);
    const v = await until(ctx, a, (v) => v.needs.some((n) => !n.read));
    seen.askHuman = {
      needs: v.needs.length,
      unreadNeeds: v.needs.filter((n) => !n.read).length,
      waiting: v.waiting.map((w) => w.why),
    };
  }
  // 2b. A turn that ends on a question, then Claude Code's idle notice:
  // still needs you (the idle notice doesn't undo it).
  {
    const a = await stub(ctx, state, "turnq");
    await turnEnd(a, `Built it.\n\n${QUESTION}`);
    await a.ctl.idlePrompt();
    const v = await until(ctx, a, (v) => v.needs.some((n) => !n.read));
    seen.endedAsking = {
      needs: v.needs.length,
      unreadNeeds: v.needs.filter((n) => !n.read).length,
      waiting: v.waiting.map((w) => w.why),
    };
  }

  // 3. A plain idle agent: its turn's end under Updates, nothing counted.
  {
    const a = await stub(ctx, state, "idle");
    state.idle = a;
    const before = (await bellFor(ctx, a)).unread;
    await turnEnd(a, "Built it. All checks pass.");
    await a.ctl.idlePrompt();
    const v = await until(ctx, a, (v) => v.updates.length > 0);
    // The idle notice comes after the turn's end; give it time to land.
    await sleep(2000);
    const w = await bellFor(ctx, a);
    seen.idle = {
      before,
      after: w.unread,
      needs: w.needs.length,
      updates: w.updates.length,
      waiting: w.waiting.map((x) => x.why),
      sawUpdate: v.updates.length > 0,
    };
  }

  // 4. Den's own "Allow the update" ask, if the bed has an update pending.
  {
    const b = await json(ctx, "/api/notifications");
    const isAsk = (n) =>
      String(n.subject).startsWith("record:den-update-") &&
      n.msg?.key === "bell.m.updateOut";
    seen.updateAsk = {
      needs: itemsOf(b.groups).filter(isAsk).length,
      needsUnread: itemsOf(b.groups).filter((n) => isAsk(n) && !n.read).length,
      updates: itemsOf(b.updates?.groups).filter(isAsk).length,
      older: itemsOf(b.older?.groups).filter(isAsk).length,
    };
  }

  // 5. Open the idle agent: its Updates items go, and the count drops.
  {
    const a = state.idle;
    const before = await bellFor(ctx, a);
    const link = before.updates.find((n) => n.link)?.link;
    let how = "none";
    if (ctx.page && link) {
      // The person's way in: the bell's row for it, under Updates.
      await ctx.page.goto(new URL("/services", ctx.url).href);
      await ctx.page.click("#den-bell");
      await ctx.page.locator('#den-bell-pop [data-bell="updates"]').click();
      const row = ctx.page
        .locator(`#den-bell-pop .den-bell-row a[href="${link}"]`)
        .first();
      if (await row.count()) {
        await row.click();
        how = "bell-row";
      } else {
        await ctx.page.goto(new URL(link, ctx.url).href);
        how = "link";
      }
      await ctx.page.bringToFront?.();
    }
    const after = await until(ctx, a, (v) => v.updates.length === 0);
    seen.opened = {
      how,
      link: link ?? null,
      beforeItems: before.updates.length,
      beforeCount: before.updatesCount,
      afterItems: after.updates.length,
      afterCount: after.updatesCount,
    };
  }
  return seen;
}

export async function teardown(ctx, state) {
  for (const a of state?.made ?? []) {
    try {
      const v = await bellFor(ctx, a);
      for (const n of [...v.needs, ...v.updates])
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
  if (state && !state.finishedWasOn)
    await post(ctx, "/api/settings", { bell_kinds: { finished: null } }).catch(
      () => {},
    );
}

/** One cell's rows. */
function rows(s) {
  const out = [];
  const p = s?.permission;
  out.push({
    clause: clauses[0],
    ok:
      !!p &&
      p.unreadNeeds > 0 &&
      p.after > p.before &&
      (p.badge === null || p.badge === String(p.apiUnread)),
    detail: JSON.stringify(p ?? null),
  });
  const q = s?.askHuman;
  const t = s?.endedAsking;
  out.push({
    clause: clauses[1],
    ok: !!q && !!t && q.unreadNeeds > 0 && t.unreadNeeds > 0,
    detail: JSON.stringify({ askHuman: q ?? null, endedAsking: t ?? null }),
  });
  const i = s?.idle;
  out.push({
    clause: clauses[2],
    ok:
      !!i &&
      i.needs === 0 &&
      i.waiting.length === 0 &&
      i.updates > 0 &&
      i.after <= i.before,
    detail: JSON.stringify(i ?? null),
  });
  const u = s?.updateAsk;
  const any = u ? u.needs + u.updates + u.older : 0;
  out.push(
    !u || any === 0
      ? { clause: clauses[3], ok: null, skip: "needs-pending-update" }
      : {
          clause: clauses[3],
          ok: u.needs > 0 && u.updates === 0 && u.needsUnread > 0,
          detail: JSON.stringify(u),
        },
  );
  const o = s?.opened;
  out.push({
    clause: clauses[4],
    ok:
      !!o &&
      o.beforeItems > 0 &&
      o.afterItems === 0 &&
      o.afterCount < o.beforeCount,
    detail: JSON.stringify(o ?? null),
  });
  return out;
}

export function expect(cells) {
  const list = Array.isArray(cells) ? cells : [{ result: cells }];
  const per = list.map((c) => rows(c?.result));
  // A clause passes when it passes in every cell that ran it.
  return clauses.map((clause, k) => {
    const got = per.map((r) => r[k]);
    if (got.every((r) => r.ok === null)) return got[0];
    const ran = got.filter((r) => r.ok !== null);
    return {
      clause,
      ok: ran.every((r) => r.ok === true),
      detail: ran.map((r) => r.detail).join(" | "),
    };
  });
}
