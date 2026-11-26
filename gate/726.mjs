// gate/726.mjs: changing a Den's Hub is clean (issue 726), run for real on a
// throwaway second Den (ctx.den2()), never the bed's own: the bed's Den is
// never repointed. d2.hubs.a and d2.hubs.b are the two Postgres test Hubs.
//
// Leg 1, the address: d2 moves from test Hub A (d2.hubs.a) to test Hub B
// (d2.hubs.b) through POST /api/settings, the path that used to skip the
// revoke. Then it connects to B.
// Then back from B to A (B's token gets 401 on B).
// Leg 2, the company: on A, d2 connects again for the second test company
// (d2.hubs.a.companies, two gate-726* entries), then for the first.
// d2.close() (teardown) disconnects it, checks its last token answers 401
// and removes the throwaway Den.
//
// Allowed by test fixture (Vision's ruling): the harness's fixture Connect
// presses Allow as the fixture person, and comments are posted by the
// harness's Hub helper, only on the two test Hubs and only in test
// companies. Nothing steps around Hub's refusal of sign-in links in agent
// sessions. The old token stays in the harness: the module only sees the
// HTTP status of a call with it.
//
// Each leg proves, as the issue words it:
//   - a comment before the change is typed once, and never again after
//     (the seen file is archived, Den's cursor is no longer the old one);
//   - a comment after the change is typed once;
//   - no project keeps an id from before, the bell offers the picks, and
//     the count drops once the project is linked again;
//   - the old token gets 401 where it was issued;
//   - the bell has no items from before; doctor shows hub:previous ok and
//     hub:unrevoked ok.
//
// Without ctx.den2 or the fixture Connect every clause skips.
import { doctorChecks } from "./lib/read-json.mjs";
export const issue = 726;
export const clauses = [
  "address change: a comment on Hub A is typed once, and after the change no old comment is typed again (A's seen file archived, its cursor not sent to B)",
  "address change: a new comment on Hub B arrives and is typed once",
  "address change: no project keeps an A id, the bell offers the picks, and after linking on B the count drops",
  "address change: the old token is revoked on A (a call with it gets 401)",
  "address change: the bell has no A items, and doctor shows hub:previous with no hub:unrevoked",
  "moving back to A: the token B issued gets 401 on B, and the Den is connected to A again",
  "company change: a comment before is typed once and never again after, and a comment in the second company is typed once",
  "company change: no project keeps the first company's id, the bell offers the picks, and after linking the count drops",
  "company change: the first company's token gets 401",
  "company change: the bell has no items from the first company, and doctor shows hub:previous with no hub:unrevoked",
];
export const timeoutMs = 600000;

const WS = "proj-gate";
const TYPED_MS = 90000;
const QUIET_MS = 20000;
const FIXTURE = "allowed by test fixture";
const NO_CONNECT = "needs-hub-connect-allow";

const parse = (b) => {
  if (b && typeof b === "object") return b;
  try {
    return JSON.parse(b);
  } catch {
    return null;
  }
};
const origin = (u) => {
  try {
    return new URL(u).origin;
  } catch {
    return "";
  }
};
const fresh = (p) =>
  `${p}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

const saveHub = (ctx, url) =>
  ctx.fetch("/api/settings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ hub_url: url }),
  });

/** The Hub address the Den uses now (GET /api/hub's url). */
async function hubUrlNow(ctx) {
  const h = await ctx.api("/api/hub?rail=1").catch(() => null);
  return h?.url ?? null;
}

async function connected(ctx) {
  const h = await ctx.api("/api/hub?rail=1").catch(() => null);
  return h?.state === "connected";
}

/** The fixture Connect to `key` (for `company`), then wait for it. */
async function connect(ctx, key, company) {
  const c = await ctx
    .hubConnect(key, company ? { company } : {})
    .catch((e) => ({ ok: false, why: String(e?.message ?? e).slice(0, 200) }));
  if (!c?.ok) return { ok: false, why: c?.why ?? "connect failed" };
  const ms = await ctx.until(() => connected(ctx), 30000);
  return ms === null
    ? { ok: false, why: "not connected after Connect" }
    : { ok: true, company: c.company ?? company ?? null };
}

/** Point the Den at `key`'s Hub and connect. */
async function moveTo(ctx, key, company) {
  const url = ctx.hubs[key].url;
  if (origin((await hubUrlNow(ctx)) ?? "") !== origin(url)) {
    const r = await saveHub(ctx, url);
    if (r.status !== 200) return { ok: false, why: `save ${r.status}` };
  }
  if (await connected(ctx)) return { ok: true };
  return connect(ctx, key, company);
}

const linkOf = (ctx) =>
  ctx.api(`/api/workspaces/${WS}/hub-project`).catch(() => null);

const linkTo = (ctx, slug) =>
  ctx.fetch(`/api/workspaces/${WS}/hub-project`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ hub: slug }),
  });

/** Link the project to the first Hub project offered, when it has none. */
async function ensureLinked(ctx) {
  const l = await linkOf(ctx);
  if (l?.hub?.id) return { id: l.hub.id, how: "linked" };
  const slug = l?.suggestions?.[0]?.slug ?? l?.projects?.[0]?.slug;
  if (!slug) return { id: null, how: "no Hub project offered" };
  const r = await linkTo(ctx, slug);
  return { id: (await linkOf(ctx))?.hub?.id ?? null, how: `PUT ${r.status}` };
}

/** Every bell item, read and unread, flattened. */
async function bellItems(ctx) {
  const n = await ctx.api("/api/notifications").catch(() => ({}));
  return [
    ...(n?.groups ?? []),
    ...(n?.updates?.groups ?? []),
    ...(n?.older?.groups ?? []),
  ]
    .flatMap((g) => (g?.subjects ?? []).map((s) => ({ g, s })))
    .flatMap(({ g, s }) =>
      (s?.items ?? []).map((i) => ({
        subject: i?.subject ?? s?.subject ?? "",
        source: i?.source ?? g?.source ?? null,
        scope: i?.scope ?? g?.scope ?? "",
        key: i?.msg?.key ?? "",
        n: i?.msg?.vars?.n ?? null,
        read: !!i?.read,
      })),
    );
}

const isHubItem = (i) =>
  i.source === "hub" ||
  String(i.scope).startsWith("hub/") ||
  /^record:(hub-comments|not-at-prompt:)/.test(i.subject) ||
  /^bell\.m\.(hub|hubOn|hubNoAnswer|notAtPrompt|held\.)/.test(i.key);

async function pickCount(ctx) {
  const p = (await bellItems(ctx)).find(
    (i) => i.subject === "record:hub-pick" && !i.read,
  );
  return p ? Number(p.n) || 0 : 0;
}

function doctorRows(ctx) {
  const j = {
    checks: doctorChecks(ctx.cli(["doctor", "--json"], { timeout: 90000 })),
  };
  const row = (id) => {
    const c = (j?.checks ?? []).find((x) => x?.id === id);
    return c ? { status: c.status, detail: String(c.detail ?? "") } : null;
  };
  return { previous: row("hub:previous"), unrevoked: row("hub:unrevoked") };
}

async function typedCount(a, since, mark) {
  try {
    const rows = await a.typed({ since });
    const t = Array.isArray(rows)
      ? rows.map((x) => x?.text ?? "").join("")
      : "";
    return t.split(mark).length - 1;
  } catch {
    return null;
  }
}

/** Post on `hub` for the stub and wait until it's typed. */
async function commentTyped(ctx, hub, a, agent, company) {
  const mark = fresh("g726");
  const since = Date.now();
  let id = null;
  try {
    id =
      (
        await hub.comment({
          agent,
          workspace: WS,
          text: `gate 726: a Hub comment (${mark})`,
          ...(company ? { company } : {}),
        })
      )?.id ?? null;
  } catch (e) {
    return { mark, id, threw: String(e?.message ?? e).slice(0, 200) };
  }
  const typedMs = await ctx.until(
    async () => ((await typedCount(a, since, mark)) ?? 0) > 0,
    TYPED_MS,
  );
  await ctx.sleep(3000);
  return { mark, id, typedMs, times: await typedCount(a, since, mark) };
}

const seenCursor = (ctx) =>
  parse(ctx.readBed("state:hub/deliveries-seen.json"))?.last ?? null;

/**
 * One leg: before the change (linked, a comment typed, the token kept),
 * the change, what's left right after, then the new side (connected,
 * linked again, a comment typed, the old one never again).
 */
async function leg(ctx, s, a, o) {
  const r = {};
  r.linkBefore = (await ensureLinked(ctx)).id;
  r.before = await commentTyped(ctx, o.fromHub, a, s.agent, o.fromCompany);
  r.cursorBefore = seenCursor(ctx);
  const tok = await ctx.hubTokenSnapshot();
  r.tokenBefore = await ctx.hubTokenStatus(tok, o.fromKey);
  const archives = (ctx.listBed("state:hub/previous") ?? []).length;
  const changedAt = Date.now();
  r.change = await o.change();
  if (!r.change.ok) return r;
  await ctx.sleep(3000);
  r.tokenAfter = await ctx.hubTokenStatus(tok, o.fromKey);
  const prev = ctx.listBed("state:hub/previous") ?? [];
  r.newArchive = prev.length > archives;
  r.archivedSeen =
    r.newArchive &&
    (ctx.listBed(`state:hub/previous/${prev[prev.length - 1]}`) ?? []).includes(
      "deliveries-seen.json",
    );
  r.cursorAfter = seenCursor(ctx);
  r.linkAfter = (await linkOf(ctx))?.hub?.id ?? null;
  r.picksAfter = await pickCount(ctx);
  r.hubItemsAfter = (await bellItems(ctx)).filter(
    (i) => isHubItem(i) && !i.read,
  ).length;
  r.doctor = doctorRows(ctx);
  r.connect = await o.connect();
  if (!r.connect.ok) return r;
  await ctx.sleep(3000);
  r.picksOnNew = await pickCount(ctx);
  const l = await ensureLinked(ctx);
  r.linkNew = l.id;
  r.linkHow = l.how;
  r.picksLinked = await pickCount(ctx);
  r.after = await commentTyped(ctx, o.toHub, a, s.agent, o.toCompany);
  await ctx.sleep(QUIET_MS);
  r.oldAgain = await typedCount(a, changedAt, r.before.mark);
  r.cursorNew = seenCursor(ctx);
  return r;
}

export async function setup(ctx) {
  if (!ctx.den2)
    return { skip: "needs-den2", why: "the bed gives no ctx.den2" };
  let d2;
  try {
    d2 = await ctx.den2();
  } catch (e) {
    // The throwaway Den needs a person signed in on it; a bed that can't
    // give it one (no fixture person there) skips as "person".
    return {
      skip: "person",
      why: `the second Den could not start signed in: ${String(e?.message ?? e).slice(0, 200)}`,
    };
  }
  const s = { d2, agent: fresh("gate-726") };
  if (!d2.hubs?.a?.url || !d2.hubs?.b?.url) s.skip = "needs-two-hubs";
  else if (!d2.hubConnect) s.skip = NO_CONNECT;
  else if (!d2.hubTokenSnapshot || !d2.hubTokenStatus)
    s.skip = "needs-token-check";
  return s;
}

export async function run(_bed, s) {
  if (s.skip) return { skip: s.skip, ...(s.why ? { why: s.why } : {}) };
  // Every step runs on the throwaway Den.
  const ctx = s.d2;
  const { a: A, b: B } = ctx.hubs;
  const out = { fixture: FIXTURE };
  const sameOrigin = origin(A.url) === origin(B.url);
  // The test companies on A (gate-726, gate-726b): leg 2 needs two.
  const ac = (A.companies ?? []).filter((c) => /^gate-726/.test(String(c)));
  const a1 = ac[0];
  const a2 = ac[1];
  const b1 = (B.companies ?? []).find((c) => /^gate-726/.test(String(c)));
  const start = await moveTo(ctx, "a", a1);
  out.start = start;
  if (!start.ok) return out;
  const stub = ctx.agent(s.agent, { workspace: WS });
  stub.start("tester");
  out.running = (await stub.running(30000)) != null;
  if (!out.running) return out;
  await ctx.sleep(2000);

  // Leg 1: A -> B by address, then back to B -> A (B's token revoked on B).
  if (sameOrigin) {
    const why = "the two test Hubs share an origin";
    out.address = { skip: "needs-two-hub-origins", why };
    out.back = { skip: "needs-two-hub-origins", why };
  } else {
    out.address = await leg(ctx, s, stub, {
      fromKey: "a",
      fromHub: A,
      fromCompany: a1,
      toHub: B,
      toCompany: b1,
      change: async () => {
        const st = (await saveHub(ctx, B.url)).status;
        return { ok: st === 200, why: `save ${st}` };
      },
      connect: () => connect(ctx, "b", b1),
    });
    out.back = { connectedB: await connected(ctx) };
    if (out.back.connectedB) {
      const tok = await ctx.hubTokenSnapshot();
      out.back.before = await ctx.hubTokenStatus(tok, "b");
      out.back.save = (await saveHub(ctx, A.url)).status;
      await ctx.sleep(3000);
      out.back.after = await ctx.hubTokenStatus(tok, "b");
    }
    out.back.onA = await moveTo(ctx, "a", a1);
  }

  // Leg 2: on A, company a1 -> a2 (Connect again), then back to a1.
  if (!a2)
    out.company = {
      skip: "needs-second-company",
      why: "Hub A has one gate-726 test company",
    };
  else if (!(await connected(ctx)))
    out.company = {
      skip: "needs-hub-a-connected",
      why: "the Den is not connected to Hub A",
    };
  else {
    out.company = await leg(ctx, s, stub, {
      fromKey: "a",
      fromHub: A,
      fromCompany: a1,
      toHub: A,
      toCompany: a2,
      // Connect again, for the other company: the change and the connect
      // are one step here.
      change: () => connect(ctx, "a", a2),
      connect: async () => ({ ok: true }),
    });
    out.company.restored = await connect(ctx, "a", a1);
  }
  return out;
}

export async function teardown(ctx, s) {
  const d2 = s?.d2;
  if (!d2) return;
  try {
    d2.agent(s.agent, { workspace: WS }).remove();
  } catch {
    /* gone, or never started */
  }
  // Disconnects (Hub revokes), checks its last token answers 401, and
  // removes the throwaway Den.
  await d2.close();
}

/** The rows for one leg: [typed, links, token, bell+doctor] (+ new comment). */
function legRows(r, names, base) {
  if (r?.skip)
    return names.map((clause) => ({
      clause,
      ok: null,
      skip: r.skip,
      ...(r.why ? { detail: r.why } : {}),
    }));
  if (base) return names.map((clause) => ({ clause, ok: false, detail: base }));
  if (!r?.change?.ok)
    return names.map((clause) => ({
      clause,
      ok: false,
      detail: `the change didn't go through: ${r?.change?.why}`,
    }));
  const fx = ` (${FIXTURE})`;
  const on = r.connect?.ok === true;
  const b = r.before ?? {};
  const a = r.after ?? {};
  const typed = {
    ok:
      b.times === 1 &&
      r.archivedSeen === true &&
      r.cursorAfter !== r.cursorBefore &&
      on &&
      r.oldAgain === 0 &&
      (r.cursorNew === null || r.cursorNew !== r.cursorBefore),
    detail: `before: typed ${b.times} time(s) in ${b.typedMs} ms${b.threw ? ` (post threw: ${b.threw})` : ""}; archived ${r.newArchive}, with the seen file ${r.archivedSeen}; Den's cursor after ${r.cursorAfter === r.cursorBefore ? "still the old one" : "not the old one"}, once connected ${r.cursorNew === r.cursorBefore ? "the old one" : "not the old one"}; the old comment typed again: ${r.oldAgain}${on ? "" : `; not connected after: ${r.connect?.why}`}${fx}`,
  };
  const fresh = {
    ok: on && a.times === 1,
    detail: on
      ? `after: typed ${a.times} time(s) in ${a.typedMs} ms${a.threw ? ` (post threw: ${a.threw})` : ""}${fx}`
      : `not connected after the change: ${r.connect?.why}`,
  };
  const links = {
    ok:
      !!r.linkBefore &&
      r.linkAfter === null &&
      r.picksAfter >= 1 &&
      on &&
      !!r.linkNew &&
      r.linkNew !== r.linkBefore &&
      r.picksLinked < r.picksAfter,
    detail: `linked before ${r.linkBefore ? "yes" : "no"}; right after the change the link is ${r.linkAfter ? (r.linkAfter === r.linkBefore ? "still the old id" : "another id") : "gone"}; the bell: ${r.picksAfter} need a pick; once connected ${r.picksOnNew}; linked ${r.linkNew ? (r.linkNew === r.linkBefore ? "to the old id" : "to a new id") : "no"} (${r.linkHow}); then ${r.picksLinked}${fx}`,
  };
  const token = {
    ok: r.tokenBefore === 200 && r.tokenAfter === 401,
    detail: `the old token: ${r.tokenBefore} before the change, ${r.tokenAfter} after`,
  };
  const bell = {
    ok:
      r.hubItemsAfter === 0 &&
      r.doctor?.previous?.status === "ok" &&
      r.doctor?.unrevoked?.status === "ok",
    detail: `unread Hub items right after the change: ${r.hubItemsAfter}; doctor hub:previous ${JSON.stringify(r.doctor?.previous)}; hub:unrevoked ${JSON.stringify(r.doctor?.unrevoked)}`,
  };
  return names.length === 5
    ? [typed, fresh, links, token, bell].map((x, i) => ({
        clause: names[i],
        ...x,
      }))
    : [
        {
          clause: names[0],
          ok: typed.ok && fresh.ok,
          detail: `${typed.detail}; ${fresh.detail}`,
        },
        { clause: names[1], ...links },
        { clause: names[2], ...token },
        { clause: names[3], ...bell },
      ];
}

export function expect(r) {
  const res = r ?? {};
  if (res.skip)
    return clauses.map((clause) => ({
      clause,
      ok: null,
      skip: res.skip,
      ...(res.why ? { detail: res.why } : {}),
    }));
  const base = !res.start?.ok
    ? `could not connect the Den to the first Hub: ${res.start?.why}`
    : !res.running
      ? `the stub did not run in ${WS}`
      : null;
  const k = res.back ?? {};
  const back = k.skip
    ? {
        clause: clauses[5],
        ok: null,
        skip: k.skip,
        ...(k.why ? { detail: k.why } : {}),
      }
    : base
      ? { clause: clauses[5], ok: false, detail: base }
      : {
          clause: clauses[5],
          ok: k.before === 200 && k.after === 401 && k.onA?.ok === true,
          detail: `B's token: ${k.before} before the move back, ${k.after} after (save ${k.save}); connected to A again: ${k.onA?.ok ? "yes" : (k.onA?.why ?? "no")}`,
        };
  return [
    ...legRows(res.address, clauses.slice(0, 5), base),
    back,
    ...legRows(res.company, clauses.slice(6), base),
  ];
}
