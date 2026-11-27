// Live check for issue 750 (G3): groups in Den, on the agents page.
//
// Den reads an install's groups from Hub (GET /api/hub/groups → Hub's GET
// /api/groups) and stores none. Until the bed's Hub serves groups (G1),
// this module answers /api/hub/groups at the page's network with groups
// naming the bed's own stub agent, as the unit tests' stub Hub does; and
// it marks that agent's row as one whose Hub tools failed to load (the
// /api/sessions answer, read from the bed, with issue 749's mcpFailed). The
// Den side drawn from them is the bed's own page. Its routes live on a
// page of the module's own, closed after. The real Hub read is checked on
// its own, and skipped while the bed's Hub has no groups route.
//
// The real-Hub leg (setup, once) runs on a throwaway second Den
// (ctx.den2()), never the bed's own, connected by the harness's fixture
// Connect to test Hub A in a gate-750 test company. Allowed by test
// fixture (Vision's ruling): the fixture person presses Allow, the
// harness's Hub helpers make the group and send to it, test companies
// only; nothing steps around Hub's refusal of sign-in links in agent
// sessions. Two stub agents: a lead whose Hub tools load, and a member
// whose session's Hub initialize fails (the stub's /hubmcp-badinit, through
// Den's real /hub/mcp proxy). Each step skips by name while the harness
// lacks what it needs.
export const issue = 750;
export const clauses = [
  "By group beside By project: each group's kit header with its lead marked, opening the group in Hub (a new tab)",
  "Message group opens Hub's composer for <group>/all in a new tab",
  "this Den's agents sit under their group, the rest under Not in a group",
  "an agent whose Hub tools failed to load shows issue 749's tag on its row in the group view, with Restart on the row",
  "no Hub connected: only the line Groups come with Den Hub, with Connect Den Hub, and no group UI",
  "403 groups_not_in_plan and a guest's 403 each show their own line, and no group UI",
  "Den reads the bed's own Hub for groups",
  "hub.groups off: the groups read answers off, and Hub isn't asked",
  "real Hub: By group reads the test group from Hub, its lead marked, and this Den's agents under it",
  "real Hub: Message group opens the test Hub's composer for the group",
  "real Hub: a group message to an agent whose Hub tools failed to load is acked held, and Hub's thread shows exactly the reason Den sent",
  "real Hub: with hub.groups off, the Den reads off and the test Hub sees no groups request",
  "real Hub: hub.groups auto (the default) reads the test group from a Hub whose whoami lists groups.read",
];
export const matrix = { browsers: ["chromium", "webkit"], widths: [1280, 390] };
export const timeoutMs = 120000;

const AGENT = "g750-member";
const HUB = "https://hub.example.test/acme";

const groupsOk = () => ({
  ok: true,
  state: "ok",
  rule: "advise",
  hub: HUB,
  groupsUrl: `${HUB}/groups`,
  groups: [
    {
      name: "Gate Group",
      slug: "g750-group",
      all: "g750-group/all",
      address: "g750-group/lead",
      lead: { name: "Gate Member", kind: "agent", agentId: AGENT, here: true },
      members: [
        {
          role: "build",
          address: "g750-group/build",
          name: "Gate Member",
          kind: "agent",
          agentId: AGENT,
          here: true,
        },
      ],
      open: `${HUB}/groups/g750-group`,
      compose: `${HUB}/groups/g750-group?compose=1`,
    },
  ],
});

// The real-Hub leg's names (test data only).
const SLUG = "g750-check";
const LEAD = "g750-lead";
const HELD = "g750-held";
const WS = "gate-750";
// What Den sends Hub for an agent whose Hub tools failed to load (issue
// 750, src/shared/hub/hub-delivery.ts HUB_TOOLS_UNAVAILABLE).
const HELD_REASON = "hub_tools_unavailable";
let D2 = null;

const msg = (e) => String(e?.message ?? e).slice(0, 200);
// A missing harness piece skips (needs-*); a product step that fails fails.
const fail = (why, detail) => ({ fail: why, why: detail ?? why });

/**
 * The groups read as the Agents page gets it, from an install's own CLI
 * (`hub groups --fresh`, issue 750): a page's /api/hub/ read isn't open
 * to the fixture person. A CLI that fails says how, never a bare null.
 */
function groupsRead(cli) {
  const r = cli(["hub", "groups", "--fresh"]);
  const line =
    String(r?.out ?? "")
      .trim()
      .split("\n")
      .pop() ?? "";
  try {
    if (r?.code === 0) return JSON.parse(line);
  } catch {
    /* said below */
  }
  return {
    error: `hub groups: ${r?.code}: ${String(r?.all ?? "")
      .trim()
      .slice(0, 200)}`,
  };
}

/**
 * Rows 7 and 8 on the bed's own Den: hub.groups on, its read of the bed's
 * Hub; then off, its read. After, the value in force before is put back:
 * the key removed when that restores it, else set to it.
 */
export function bedGroups(ctx) {
  if (!ctx.cli) return skip("needs-bed-cli", "the bed gives no ctx.cli");
  const now = () => {
    const r = ctx.cli(["config", "hub.groups"]);
    const v = String(r.out ?? "").trim();
    return r.code === 0 && ["auto", "on", "off"].includes(v) ? v : null;
  };
  const was = now();
  if (!was)
    return fail("config", "`config hub.groups` didn't print auto, on or off");
  const set = (v) => ctx.cli(["config", `hub.groups=${v}`]);
  try {
    const on = set("on");
    if (on.code !== 0) return fail("config", `hub.groups=on: ${on.code}`);
    const real = groupsRead(ctx.cli);
    const off = set("off");
    if (off.code !== 0)
      return { real, off: fail("config", `hub.groups=off: ${off.code}`) };
    return { real, off: groupsRead(ctx.cli) };
  } finally {
    ctx.cli(["config", "rm", "hub.groups"]);
    if (now() !== was) set(was);
  }
}
const skip = (why, detail) => ({
  skip: why,
  ...(detail ? { why: detail } : {}),
});

async function poll(ctx, f, ms, every = 1000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await f().catch(() => null);
    if (v || Date.now() >= end) return v;
    await ctx.sleep(every);
  }
}

/** The real-Hub leg: every value it returns is plain JSON. */
async function hubLeg(ctx) {
  if (!ctx.den2) return skip("needs-den2", "the bed gives no ctx.den2");
  let d2;
  try {
    // A test install (den-bed's fixture-person exception for den2): its
    // page and API run as the fixture person, on test Hubs only.
    d2 = await ctx.den2({ product: { testInstall: true } });
  } catch (e) {
    return skip(
      "needs-den2-person",
      `the second Den could not start signed in: ${msg(e)}`,
    );
  }
  D2 = d2;
  const A = d2.hubs?.a;
  const company = (A?.companies ?? []).find((c) => /^gate-750/.test(String(c)));
  if (!A?.url) return skip("needs-test-hub");
  if (!company)
    return skip(
      "needs-gate-750-company",
      "test Hub A lists no gate-750 company",
    );
  if (!d2.hubConnect) return skip("needs-fixture-connect");
  if (!A.group || !A.groupSend || !A.groupThread)
    return skip(
      "needs-hub-group-fixture",
      "no group / groupSend / groupThread on test Hub A",
    );
  const out = { fixture: "allowed by test fixture", hub: A.url, company };
  try {
    const on = d2.cli(["config", "hub.groups=on"]);
    if (on.code !== 0)
      return { ...out, ...fail("config", `hub.groups=on: ${on.code}`) };
    const c = await d2.hubConnect("a", { company });
    if (!c?.ok)
      return { ...out, ...fail("connect", c?.why ?? "fixture Connect failed") };
    // The check's own project on the throwaway Den (a test install's
    // fixture person may make its own projects, issue 1215): the agents
    // start in it. Already there (a rerun) is fine.
    const mk = d2.cli(["workspace", "create", WS]);
    const mkSaid = String(mk.all ?? "");
    if (mk.code !== 0 && !/already/i.test(mkSaid))
      return {
        ...out,
        ...fail("project", `workspace create ${WS}: ${mk.code} ${mkSaid.trim().slice(0, 160)}`),
      };
    const act = d2.cli(["workspace", "activate", WS]);
    if (act.code !== 0)
      return {
        ...out,
        ...fail("project", `workspace activate ${WS}: ${act.code}`),
      };
    // Both agents tell Hub they exist (a Hub call through Den's proxy).
    const lead = d2.agent(LEAD, { workspace: WS });
    const held = d2.agent(HELD, { workspace: WS });
    lead.start("tester");
    held.start("tester");
    if (
      (await lead.running(30000)) == null ||
      (await held.running(30000)) == null
    )
      return { ...out, ...fail("agents", "the stub agents didn't start") };
    // A raw line typed into the stub (its /hubmcp commands): ctx.agent(id).line.
    if (!lead.line)
      return {
        ...out,
        ...skip("needs-stub-line", "no ctx.agent(id).line(text)"),
      };
    lead.line("/hubmcp hub_whoami {}");
    held.line("/hubmcp hub_whoami {}");
    if (!lead.hubIdentity || !held.hubIdentity)
      return {
        ...out,
        ...skip("needs-hub-identity", "no ctx.agent(id).hubIdentity()"),
      };
    const idLead = await poll(ctx, () => lead.hubIdentity(), 20000);
    const idHeld = await poll(ctx, () => held.hubIdentity(), 20000);
    if (!idLead?.install || !idHeld?.install)
      return {
        ...out,
        ...fail("hub-identity", "Hub doesn't know the stub agents yet"),
      };
    await A.group(company, SLUG, {
      name: "G750 check",
      leadAgent: `${idLead.install}:${idLead.agentKey}`,
      // escalates: left to the harness's default, the test Hub's fixture person.
      roles: { held: `${idHeld.install}:${idHeld.agentKey}` },
    });

    // (1) Den reads the group from Hub, its lead and member marked as here.
    const read = await poll(
      ctx,
      async () => {
        const r = groupsRead(d2.cli);
        return r?.state === "ok" && r.groups?.some((g) => g.slug === SLUG)
          ? r
          : null;
      },
      20000,
    );
    const g = read?.groups?.find((x) => x.slug === SLUG) ?? null;
    out.read = {
      state: read?.state ?? null,
      found: !!g,
      leadHere: g?.lead?.here === true && g?.lead?.agentId === LEAD,
      heldHere: !!g?.members?.some(
        (m) => m.agentId === HELD && m.here === true,
      ),
      compose: g?.compose ?? null,
    };

    // (2) Message group: Hub's composer for the group, and Hub serves it.
    const want = `${A.url.replace(/\/$/, "")}/${company}/groups/${SLUG}?compose=1`;
    out.compose = {
      want,
      got: g?.compose ?? null,
      origin: new URL(A.url).origin,
    };
    if (g?.compose) {
      const r = await fetch(g.compose, { redirect: "manual" }).catch((e) => ({
        status: msg(e),
      }));
      out.compose.status = r.status;
      out.compose.location = r.headers?.get?.("location") ?? null;
    }

    // (3) The member's Hub tools fail to load; a group message to it is held.
    held.line("/hubmcp-badinit");
    const failed = await poll(
      ctx,
      async () => {
        const ss = await d2.api("/api/sessions?all=1");
        const row = (ss?.sessions ?? []).find((x) => x.agent === HELD);
        return Array.isArray(row?.mcpFailed) && row.mcpFailed.length
          ? row.mcpFailed
          : null;
      },
      20000,
    );
    out.failed = !!failed;
    if (failed) {
      const sent = await A.groupSend(
        company,
        `${SLUG}/all`,
        `gate 750 check ${Date.now()}`,
      );
      out.thread = sent?.thread ?? null;
      const marks = await poll(
        ctx,
        async () => {
          const t = await A.groupThread(company, sent.thread);
          const m = (t ?? []).find((x) => x.address === `${SLUG}/held`);
          return m && m.state === "held" ? t : null;
        },
        60000,
        2000,
      );
      const m = (marks ?? []).find((x) => x.address === `${SLUG}/held`) ?? null;
      out.held = { state: m?.state ?? null, reason: m?.reason ?? null };
    }

    // (4) Off: the Den reads off, and Hub sees no groups request from it.
    // The control first: the same fresh read with groups on must reach
    // Hub, so a count of 0 can't come from a Den that never calls this Hub
    // or a prefix that never matches.
    if (!A.requests)
      out.off = skip("needs-hub-request-count", "no requests() on test Hub A");
    else {
      const onSince = new Date().toISOString();
      groupsRead(d2.cli);
      await ctx.sleep(2000);
      const onRequests = await A.requests("/api/groups", { since: onSince });
      const off = d2.cli(["config", "hub.groups=off"]);
      if (off.code !== 0)
        out.off = {
          onRequests,
          ...fail("config", `hub.groups=off: ${off.code}`),
        };
      else {
        const since = new Date().toISOString();
        const r = groupsRead(d2.cli);
        await ctx.sleep(2000);
        out.off = {
          state: r?.state ?? null,
          onRequests,
          requests: await A.requests("/api/groups", { since }),
        };
      }
    }

    // (5) Auto, the default: on by itself when the test Hub's whoami
    // lists groups.read. Den says when Hub doesn't (a named skip).
    const au = d2.cli(["config", "hub.groups=auto"]);
    if (au.code !== 0) out.auto = fail("config", `hub.groups=auto: ${au.code}`);
    else {
      const r = groupsRead(d2.cli);
      out.auto = {
        state: r?.state ?? null,
        why: r?.why ?? null,
        found: !!r?.groups?.some((g) => g.slug === SLUG),
        ...(r?.error ? { error: r.error } : {}),
      };
    }
  } catch (e) {
    out.error = msg(e);
  }
  return out;
}

export async function setup(ctx) {
  const a = ctx.agent(AGENT);
  a.start("tester");
  const s = { runMs: await a.running(20000) };
  try {
    s.bed = bedGroups(ctx);
  } catch (e) {
    s.bed = { error: msg(e) };
  }
  s.hubLeg = await hubLeg(ctx).catch((e) => ({ error: msg(e) }));
  return s;
}

export async function run(ctx, s) {
  const tag = `${ctx.browser}-${ctx.width}`;
  const out = { ...s, tag };
  const p = await ctx.page.context().newPage();
  let groups = groupsOk();
  try {
    await p.addInitScript(() => {
      try {
        localStorage.setItem("den-agents-by", "group");
      } catch {
        /* none */
      }
    });
    await p.route("**/api/hub/groups*", (r) => r.fulfill({ json: groups }));
    await p.route("**/api/sessions*", async (r) => {
      if (r.request().method() !== "GET") return r.continue();
      const res = await r.fetch();
      let b = null;
      try {
        b = await res.json();
      } catch {
        return r.fulfill({ response: res });
      }
      for (const x of b?.sessions ?? [])
        if (x.agent === AGENT && x.state === "running")
          x.mcpFailed = [
            { server: "hub", error: "hub (503)", at: new Date().toISOString() },
          ];
      return r.fulfill({ response: res, json: b });
    });

    // ── With groups: By group ──
    await ctx.goto(p, "/agents");
    await p
      .locator('[data-group="g750-group"] > [data-group="g750-group"]')
      .waitFor({ timeout: 20000 })
      .catch(() => {});
    await p
      .locator(
        `[data-group="g750-group"] [data-agent] [data-act="tools-restart"]`,
      )
      .waitFor({ timeout: 10000 })
      .catch(() => {});
    out.groups = await p.evaluate((agent) => {
      // The group's section holds its kit header; both carry data-group.
      const h = document.querySelector(
        '[data-group="g750-group"] > [data-group="g750-group"]',
      );
      const g = h?.parentElement;
      // The header's name link has a title; Message group, an aria-label.
      const name = h?.querySelector("a[title]");
      const act = h?.querySelector("a[aria-label]");
      const sw = document.querySelector("[data-by-switch]");
      const none = document.querySelector("[data-group-none]");
      const row = g?.querySelector("button[data-id]");
      const wrap = g?.querySelector(`div[data-agent="${agent}"][data-ws]`);
      return {
        switch: sw
          ? [...sw.querySelectorAll("button[data-by]")].map((b) => [
              b.dataset.by,
              b.getAttribute("aria-pressed"),
            ])
          : null,
        lead: h?.querySelector("[data-lead]")?.textContent?.trim() ?? null,
        leadMark: !!h?.querySelector('[data-lead] [aria-hidden="true"]'),
        nameHref: name?.getAttribute("href") ?? null,
        nameTarget: name?.getAttribute("target") ?? null,
        actHref: act?.getAttribute("href") ?? null,
        actTarget: act?.getAttribute("target") ?? null,
        actText: act?.textContent?.trim() ?? null,
        memberRow: !!row && (row.textContent ?? "").length > 0,
        memberInGroup: !!g?.querySelector("button[data-id]") && !!wrap,
        notInGroup: none
          ? (none.firstElementChild?.textContent ?? "").trim()
          : null,
        unreach:
          wrap?.querySelector('[data-mcp-failed="hub"]')?.textContent?.trim() ??
          null,
        restart: !!wrap?.querySelector('button[data-act="tools-restart"]'),
        sideScroll:
          document.documentElement.scrollWidth >
          document.documentElement.clientWidth + 1,
      };
    }, AGENT);
    await ctx.shotOf(p, `by-group-${tag}`);

    // ── No Hub, the plan, a guest ──
    const lines = {};
    for (const [k, body] of [
      ["none", { ok: true, state: "none" }],
      ["unavailable", { ok: true, state: "unavailable", hub: HUB }],
      ["refused", { ok: true, state: "refused" }],
    ]) {
      groups = body;
      await ctx.goto(p, "/agents");
      await p
        .locator("[data-note^='groups-']")
        .waitFor({ timeout: 15000 })
        .catch(() => {});
      lines[k] = await p.evaluate(() => {
        const n = document.querySelector("[data-note^='groups-']");
        return {
          note: n?.getAttribute("data-note") ?? null,
          text: n?.textContent?.trim() ?? null,
          link: n?.querySelector("a")?.getAttribute("href") ?? null,
          linkText: n?.querySelector("a")?.textContent?.trim() ?? null,
          groupUi: document.querySelectorAll(
            "[data-by-switch], [data-group], [data-group-none]",
          ).length,
          byProject: document.querySelectorAll("div[data-ws]:not([data-agent])")
            .length,
        };
      });
      await ctx.shotOf(p, `line-${k}-${tag}`);
    }
    out.lines = lines;
  } finally {
    await p.close().catch(() => {});
  }
  return out;
}

export function expect(cells) {
  const list = Array.isArray(cells) ? cells : [{ cell: {}, result: cells }];
  const all = (f) => list.every(({ result }) => f(result ?? {}));
  const say = (f) =>
    list.map(({ result: r }) => `${r?.tag}: ${f(r ?? {})}`).join("; ");
  const shots = (pre) => list.map(({ result: r }) => `${pre}-${r?.tag}`);
  const g = (r) => r.groups ?? {};
  const L = (r, k) => r.lines?.[k] ?? {};
  const rows = [
    {
      clause: clauses[0],
      ok: all(
        (r) =>
          JSON.stringify(g(r).switch) ===
            JSON.stringify([
              ["project", "false"],
              ["group", "true"],
            ]) &&
          g(r).leadMark &&
          /Gate Member/.test(g(r).lead ?? "") &&
          g(r).nameHref === `${HUB}/groups/g750-group` &&
          g(r).nameTarget === "_blank" &&
          !g(r).sideScroll,
      ),
      detail: say(
        (r) =>
          `switch ${JSON.stringify(g(r).switch)}, lead "${g(r).lead}" marked ${g(r).leadMark}, open ${g(r).nameHref} (${g(r).nameTarget}), side scroll ${g(r).sideScroll}`,
      ),
      evidence: shots("by-group"),
    },
    {
      clause: clauses[1],
      ok: all(
        (r) =>
          g(r).actHref === `${HUB}/groups/g750-group?compose=1` &&
          g(r).actTarget === "_blank",
      ),
      detail: say(
        (r) => `"${g(r).actText}" → ${g(r).actHref} (${g(r).actTarget})`,
      ),
      evidence: shots("by-group"),
    },
    {
      clause: clauses[2],
      ok: all((r) => g(r).memberInGroup),
      detail: say(
        (r) =>
          `member in its group ${g(r).memberInGroup}; Not in a group: ${g(r).notInGroup ?? "(none: every row is in a group)"}`,
      ),
      evidence: shots("by-group"),
    },
    {
      clause: clauses[3],
      ok: all((r) => !!g(r).unreach && g(r).restart === true),
      detail: say(
        (r) => `tag "${g(r).unreach}", Restart on the row ${g(r).restart}`,
      ),
      evidence: shots("by-group"),
    },
    {
      clause: clauses[4],
      ok: all(
        (r) =>
          L(r, "none").note === "groups-hub" &&
          L(r, "none").link === "/settings#agents.hub" &&
          L(r, "none").groupUi === 0,
      ),
      detail: say(
        (r) =>
          `"${L(r, "none").text}" → ${L(r, "none").link}; group UI ${L(r, "none").groupUi}; by project ${L(r, "none").byProject}`,
      ),
      evidence: shots("line-none"),
    },
    {
      clause: clauses[5],
      ok: all(
        (r) =>
          L(r, "unavailable").note === "groups-plan" &&
          L(r, "unavailable").link === HUB &&
          L(r, "unavailable").groupUi === 0 &&
          L(r, "refused").note === "groups-guest" &&
          L(r, "refused").link === null &&
          L(r, "refused").groupUi === 0,
      ),
      detail: say(
        (r) =>
          `plan "${L(r, "unavailable").text}" → ${L(r, "unavailable").link}; guest "${L(r, "refused").text}"`,
      ),
      evidence: [...shots("line-unavailable"), ...shots("line-refused")],
    },
  ];
  rows.push(...bedRows(list[0]?.result?.bed ?? null));
  rows.push(...hubRows(list[0]?.result?.hubLeg ?? null));
  return rows;
}

/**
 * Rows 7 and 8, from the bed's own Den (bedGroups). A read of the bed's
 * Hub that finds no groups there skips by name; a CLI or config that
 * fails is the product's, and fails.
 */
export function bedRows(b) {
  const [c7, c8] = [clauses[6], clauses[7]];
  if (!b)
    return [c7, c8].map((clause) => ({
      clause,
      ok: null,
      skip: "needs-bed-groups",
      detail: "the bed's groups step didn't run",
    }));
  if (b.skip)
    return [c7, c8].map((clause) => ({
      clause,
      ok: null,
      skip: b.skip,
      detail: b.why ?? b.skip,
    }));
  if (b.fail || b.error)
    return [c7, c8].map((clause) => ({
      clause,
      ok: false,
      detail: b.fail ? `${b.fail}: ${b.why}` : `error: ${b.error}`,
    }));
  const real = b.real ?? {};
  const said = (r) =>
    r.error ? r.error : `${r.state}${r.why ? ` (${r.why})` : ""}`;
  const rows = [];
  if (real.error)
    rows.push({
      clause: c7,
      ok: false,
      detail: `the bed's Den: ${real.error}`,
    });
  else if (["ok", "unavailable", "refused"].includes(real.state))
    rows.push({ clause: c7, ok: true, detail: `the bed's Hub: ${real.state}` });
  else if (real.state === "rejected")
    // Hub refused Den's own token: Den's credential, never "not run".
    rows.push({
      clause: c7,
      ok: false,
      detail: "the bed's Hub refused Den's token (rejected)",
    });
  else
    // off: the bed's Hub has no groups route; none: no Hub connected;
    // unreachable: the bed's Hub didn't answer.
    rows.push({
      clause: c7,
      ok: null,
      skip: real.state === "none" ? "needs-bed-hub" : "needs-hub-groups",
      detail: `the bed's Hub: ${said(real)}`,
    });
  const off = b.off ?? {};
  rows.push(
    off.fail
      ? { clause: c8, ok: false, detail: `${off.fail}: ${off.why}` }
      : {
          clause: c8,
          ok: off.state === "off" && !off.error,
          detail: `the bed's Den with hub.groups off: ${said(off)}`,
        },
  );
  return rows;
}

/** The real-Hub leg's five rows: a skip names the missing harness piece;
 *  a product step that failed fails all five, with its reason. */
export function hubRows(h) {
  const at = (i) => clauses[8 + i];
  const ALL = [0, 1, 2, 3, 4];
  const skipped = (why, detail) =>
    ALL.map((i) => ({ clause: at(i), ok: null, skip: why, detail }));
  if (!h) return skipped("needs-hub-leg", "the leg didn't run");
  if (h.skip) return skipped(h.skip, h.why ?? h.skip);
  if (h.fail || (h.error && !h.read))
    return ALL.map((i) => ({
      clause: at(i),
      ok: false,
      detail: h.fail ? `${h.fail}: ${h.why}` : `error: ${h.error}`,
    }));
  const rows = [];
  const r = h.read ?? {};
  rows.push({
    clause: at(0),
    ok:
      r.state === "ok" &&
      r.found === true &&
      r.leadHere === true &&
      r.heldHere === true,
    detail: `read ${r.state}; group ${r.found ? "found" : "missing"}; lead here ${r.leadHere}; member here ${r.heldHere} (${h.fixture})`,
  });
  const c = h.compose ?? {};
  rows.push({
    clause: at(1),
    ok: !!c.got && c.got === c.want && served(c),
    detail: `compose ${c.got} (want ${c.want}), Hub answered ${c.status}${c.location ? ` → ${c.location}` : ""}`,
  });
  const held = h.held ?? {};
  rows.push(
    h.failed === false
      ? {
          clause: at(2),
          ok: false,
          detail: "the member's Hub tools never showed as failed",
        }
      : {
          clause: at(2),
          ok: held.state === "held" && held.reason === HELD_REASON,
          detail: `thread ${h.thread}: the member's mark ${held.state} "${held.reason}" (want held "${HELD_REASON}")`,
        },
  );
  const off = h.off ?? {};
  rows.push(
    off.skip
      ? { clause: at(3), ok: null, skip: off.skip, detail: off.why ?? off.skip }
      : off.fail
        ? { clause: at(3), ok: false, detail: `${off.fail}: ${off.why}` }
        : {
            clause: at(3),
            ok:
              off.onRequests >= 1 && off.state === "off" && off.requests === 0,
            detail: `groups requests to Hub while on: ${off.onRequests}; read ${off.state} when off; requests since: ${off.requests}`,
          },
  );
  const au = h.auto;
  rows.push(
    !au
      ? { clause: at(4), ok: false, detail: "auto was not read" }
      : au.fail
        ? { clause: at(4), ok: false, detail: `${au.fail}: ${au.why}` }
        : au.state === "off" && au.why === "hub-lacks-groups-read"
          ? {
              clause: at(4),
              ok: null,
              skip: "needs-hub-groups-read",
              detail: "the test Hub's whoami lists no groups.read yet",
            }
          : {
              clause: at(4),
              ok: au.state === "ok" && au.found === true,
              detail: `auto read ${au.error ?? au.state}; group ${au.found ? "found" : "missing"}`,
            },
  );
  // An error thrown after the read: the rows it cut short say so.
  if (h.error)
    for (const x of rows)
      if (x.ok === false) x.detail += ` (error: ${h.error})`;
  return rows;
}

/** Hub served the composer: a 2xx, or a 3xx that stays on the test Hub. */
function served(c) {
  if (typeof c.status !== "number") return false;
  if (c.status >= 200 && c.status < 300) return true;
  if (c.status < 300 || c.status >= 400 || !c.location) return false;
  try {
    return new URL(c.location, c.origin).origin === c.origin;
  } catch {
    return false;
  }
}

export async function teardown(ctx) {
  try {
    if (ctx.agent(AGENT).state()) ctx.agent(AGENT).remove();
  } finally {
    if (D2) {
      const d = D2;
      D2 = null;
      await d.close().catch(() => {});
    }
  }
}
