export const issue = 1380;
export const items = [1380];
export const clauses = [
  "an agent withdraws its own pending held write with ask_withdraw: Den says so, and the request leaves Needs you",
  'the bell keeps it as "<agent> withdrew its request: <what>. Withdrawn: <reason>"',
  "an Allow pressed after the withdraw runs nothing: Den answers already decided, and the setting is unchanged",
  "another agent's withdraw is refused (not_asker) and recorded, and the request still waits",
];
export const timeoutMs = 300000;

const WS = "proj-gate";
const OWN = "g1380-own";
const OTHER = "g1380-other";
const KEY = "sessions.close_grace_seconds";
const VALUE = 9;
const NOTE = "gate check 1380";
const REASON = "gate check 1380 withdraws its own request";
const OTHER_REASON = "gate check 1380 tries another agents request";
const OPERATOR_OFF = [
  "fixture_scope",
  "fixture_cannot_approve",
  "operator_not_test_bed",
  "operator_action_not_allowed",
];
const D2S = [];

const msg = (e) => String(e?.message ?? e).slice(0, 200);
const cut = (s, n = 200) =>
  String(s ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, n);

async function poll(ctx, f, ms, every = 1000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await f().catch(() => null);
    if (v || Date.now() >= end) return v;
    await ctx.sleep(every);
  }
}

function configValue(d2) {
  const text = d2.readBed("config/local/user.yml");
  if (typeof text !== "string") return null;
  const block = /^sessions:\n((?:[ \t]+.*\n?|\n)*)/m.exec(text)?.[1] ?? "";
  const m = /^[ \t]+close_grace_seconds:[ \t]*["']?(\d+)/m.exec(block);
  return m ? m[1] : "unset";
}

function bellItems(body) {
  const out = [];
  const walk = (v) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") {
      if (typeof v.text === "string") out.push(v);
      Object.values(v).forEach(walk);
    }
  };
  walk(body);
  return out;
}

async function waitingIds(d2) {
  const b = await d2.api("/api/notifications");
  return (b?.waiting ?? []).map((w) => w.id);
}

function heldState(d2, rid) {
  try {
    const j = JSON.parse(d2.readBed("state:held-writes.json") || "{}");
    const list = Array.isArray(j)
      ? j
      : (j.items ?? j.requests ?? Object.values(j));
    const h = list.find((x) => x?.id === rid);
    return h ? (h.state ?? "none") : "not on file";
  } catch {
    return "unreadable";
  }
}

function withdrawLines(d2, rid) {
  const out = [];
  for (const line of (d2.readBed("state:audit.jsonl") || "").split("\n")) {
    if (!line.includes(rid)) continue;
    try {
      const e = JSON.parse(line);
      if (e.verb === "approval-withdraw")
        out.push({
          actor: e.actor,
          outcome: e.outcome ?? "done",
          reason: e.reason,
        });
    } catch {
      continue;
    }
  }
  return out;
}

async function said(ctx, d2, id, mark, ms) {
  return poll(
    ctx,
    async () => {
      const rows = d2.stubLog?.(id, { k: "sh" }) ?? [];
      const v = rows
        .filter((r) => String(r?.v?.cmd ?? "").includes(mark))
        .at(-1)?.v;
      return v
        ? {
            status: v.status ?? null,
            said: cut(`${v.out ?? ""} ${v.err ?? ""}`, 400),
          }
        : null;
    },
    ms,
  );
}

export async function setup(ctx) {
  if (!ctx.den2) return { error: "the bed gives no ctx.den2" };
  let d2;
  try {
    d2 = await ctx.den2({
      product: { testInstall: true, denYml: { install_mode: "strict" } },
    });
  } catch (e) {
    return { error: `den2 (strict): ${msg(e)}` };
  }
  D2S.push(d2);
  const s = { running: {} };
  for (const id of [OWN, OTHER]) {
    const a = d2.agent(id, { workspace: WS });
    a.start("tester");
    s.running[id] = await a.running(30000);
  }
  const m = await d2.api("/api/settings").catch(() => null);
  s.mode = {
    mode: m?.install_mode ?? null,
    from: m?.install_mode_from ?? null,
  };
  return s;
}

export async function run(ctx, s) {
  if (s.error) return s;
  const d2 = D2S[0];
  const own = d2.agent(OWN, { workspace: WS });
  const other = d2.agent(OTHER, { workspace: WS });
  const r = { ...s };
  if (s.running[OWN] == null || s.running[OTHER] == null) {
    r.error = `a stub never ran: ${JSON.stringify(s.running)}`;
    return r;
  }
  r.before = configValue(d2);
  await own.mcp("setting_change", { key: KEY, value: VALUE, reason: NOTE });
  const held = await poll(
    ctx,
    async () => {
      const b = await d2.api("/api/notifications");
      return (b?.waiting ?? []).find(
        (w) =>
          w.action === "setting_change" && String(w.what ?? "").includes(KEY),
      );
    },
    30000,
  );
  r.rid = held?.id ?? null;
  r.whileHeld = configValue(d2);
  if (!r.rid) return r;

  await other.mcp("ask_withdraw", { request: r.rid, reason: OTHER_REASON });
  r.other = await said(ctx, d2, OTHER, r.rid, 30000);
  r.otherStillWaiting = (await waitingIds(d2).catch(() => [])).includes(r.rid);
  r.otherAudit = withdrawLines(d2, r.rid);

  await own.mcp("ask_withdraw", { request: r.rid, reason: REASON });
  r.own = await said(ctx, d2, OWN, `"request":"${r.rid}"`, 100000);
  r.gone =
    (await poll(
      ctx,
      async () => !(await waitingIds(d2)).includes(r.rid),
      15000,
    )) === true;
  r.state = heldState(d2, r.rid);
  const kept = await poll(
    ctx,
    async () =>
      bellItems(await d2.api("/api/notifications")).find(
        (i) =>
          i.subject === `record:held-withdrawn-${r.rid}` ||
          i.text.includes(`Withdrawn: ${REASON}`),
      ),
    15000,
  );
  r.bell = kept
    ? { text: cut(kept.text, 300), subject: kept.subject ?? null }
    : null;

  const late = await d2
    .fetch(`/api/approvals/${encodeURIComponent(r.rid)}/decide`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "allow" }),
    })
    .catch((e) => ({ status: null, body: { error: msg(e) } }));
  r.late = {
    status: late.status,
    code: late.body?.code ?? null,
    error: cut(late.body?.error),
  };
  await ctx.sleep(3000);
  r.after = configValue(d2);
  r.audit = withdrawLines(d2, r.rid);
  const fs = await import("fs");
  fs.writeFileSync(ctx.evidence("1380-run.json"), JSON.stringify(r, null, 2));
  return r;
}

export async function teardown() {
  for (const d of D2S.splice(0)) {
    for (const id of [OWN, OTHER])
      try {
        if (d.agent(id, { workspace: WS }).state())
          d.agent(id, { workspace: WS }).remove();
      } catch {
        continue;
      }
    await d.close().catch(() => {});
  }
}

const row = (clause, ok, detail, skip) => ({
  clause,
  ok: skip ? null : ok,
  ...(skip ? { skip } : {}),
  detail,
  evidence: ["1380-run.json"],
});

export function expect(cells) {
  const r =
    (Array.isArray(cells) ? cells.find((c) => c?.result)?.result : cells) ?? {};
  const base = `mode ${JSON.stringify(r.mode)}; request ${r.rid ?? "none"}`;
  if (r.error || !r.rid) {
    const why =
      r.error ??
      `no held setting_change showed in Needs you (${base}; config ${r.before} → ${r.whileHeld})`;
    return clauses.map((c) => row(c, false, why));
  }
  const strict = r.mode?.mode === "strict";
  const nothingWritten = r.whileHeld === r.before && r.after === r.before;
  const own = r.own ?? {};
  const other = r.other ?? {};
  const operatorOff =
    r.late?.status === 403 && OPERATOR_OFF.includes(r.late?.code);
  return [
    row(
      clauses[0],
      strict &&
        own.status === 0 &&
        own.said.includes(`Withdrawn. Your request ${r.rid}`) &&
        r.gone === true &&
        r.state !== "pending",
      `${base}; the agent's call: ${JSON.stringify(own)}; left Needs you: ${r.gone}; on file: ${r.state}`,
    ),
    row(
      clauses[1],
      !!r.bell &&
        r.bell.text.includes(`${OWN} withdrew its request:`) &&
        r.bell.text.includes(`Withdrawn: ${REASON}`),
      `${base}; bell: ${JSON.stringify(r.bell)}`,
    ),
    row(
      clauses[2],
      (r.late?.status === 409 || r.late?.status === 410) && nothingWritten,
      `${base}; late Allow: ${JSON.stringify(r.late)}; config ${r.before} → ${r.whileHeld} → ${r.after}${operatorOff ? "; the test operator's Allow never reached the request on this den2 (test-install mark or testBed mark missing)" : ""}`,
      operatorOff ? "needs-operator-allow" : undefined,
    ),
    row(
      clauses[3],
      other.status !== 0 &&
        other.status != null &&
        other.said.includes("not_asker") &&
        r.otherStillWaiting === true &&
        (r.otherAudit ?? []).some((a) => a.outcome === "refused"),
      `${base}; the other agent's call: ${JSON.stringify(other)}; still waiting after it: ${r.otherStillWaiting}; audit: ${JSON.stringify(r.otherAudit)}`,
    ),
  ];
}
