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
  "hub.groups off (the default): the page's groups read answers off, and Hub isn't asked",
  "real Hub: By group reads the test group from Hub, its lead marked, and this Den's agents under it",
  "real Hub: Message group opens the test Hub's composer for the group",
  "real Hub: a group message to an agent whose Hub tools failed to load is acked held, and Hub's thread shows exactly the reason Den sent",
  "real Hub: with hub.groups off, the Den reads off and the test Hub sees no groups request",
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
// 750, src/shared/hub-delivery.ts HUB_TOOLS_UNAVAILABLE).
const HELD_REASON = "hub_tools_unavailable";
let D2 = null;

const msg = (e) => String(e?.message ?? e).slice(0, 200);
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
      "person",
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
    const on = d2.cli(["config", "hub.groups=true"]);
    if (on.code !== 0)
      return { ...out, ...skip("config", `hub.groups=true: ${on.code}`) };
    const c = await d2.hubConnect("a", { company });
    if (!c?.ok)
      return { ...out, ...skip("connect", c?.why ?? "fixture Connect failed") };
    // Both agents tell Hub they exist (a Hub call through Den's proxy).
    const lead = d2.agent(LEAD, { workspace: WS });
    const held = d2.agent(HELD, { workspace: WS });
    lead.start("tester");
    held.start("tester");
    if (
      (await lead.running(30000)) == null ||
      (await held.running(30000)) == null
    )
      return { ...out, ...skip("agents", "the stub agents didn't start") };
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
        ...skip("hub-identity", "Hub doesn't know the stub agents yet"),
      };
    await A.group(company, SLUG, {
      name: "Gate 750 check",
      leadAgent: `${idLead.install}:${idLead.agentKey}`,
      // escalates: left to the harness's default, the test Hub's fixture person.
      roles: { held: `${idHeld.install}:${idHeld.agentKey}` },
    });

    // (1) Den reads the group from Hub, its lead and member marked as here.
    const read = await poll(
      ctx,
      async () => {
        const r = await d2.api("/api/hub/groups?fresh=1");
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
    out.compose = { want, got: g?.compose ?? null };
    if (g?.compose) {
      const r = await fetch(g.compose, { redirect: "manual" }).catch((e) => ({
        status: msg(e),
      }));
      out.compose.status = r.status;
    }

    // (3) The member's Hub tools fail to load; a group message to it is held.
    held.line("/hubmcp-badinit");
    const failed = await poll(
      ctx,
      async () => {
        const ss = await d2.api("/api/sessions");
        const row = (ss?.rows ?? ss ?? []).find?.((x) => x.agent === HELD);
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
    const off = d2.cli(["config", "hub.groups=false"]);
    if (!A.requests)
      out.off = skip("needs-hub-request-count", "no requests() on test Hub A");
    else if (off.code !== 0)
      out.off = skip("config", `hub.groups=false: ${off.code}`);
    else {
      const since = new Date().toISOString();
      const r = await d2.api("/api/hub/groups?fresh=1");
      await ctx.sleep(2000);
      out.off = {
        state: r?.state ?? null,
        requests: await A.requests("/api/groups", { since }),
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
  // The bed's own Hub, through Den (no page routes).
  // A failed read says why (status, message), never a bare null.
  const real = await ctx.api("/api/hub/groups").catch((e) => ({
    error: String(e?.message ?? e).slice(0, 200),
  }));
  out.real = real?.state ?? null;
  if (real?.error) out.realError = real.error;
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
  const real = list[0]?.result?.real ?? null;
  const realError = list[0]?.result?.realError ?? null;
  // Until the bed's Hub serves GET /api/groups (G1), Den says it can't.
  if (real === "ok" || real === "unavailable" || real === "refused")
    rows.push({
      clause: clauses[6],
      ok: true,
      detail: `the bed's Hub: ${real}`,
    });
  else
    rows.push({
      clause: clauses[6],
      ok: null,
      skip: "needs-hub-groups",
      detail: `the bed's Hub: ${real}${realError ? ` (${realError})` : ""}`,
    });
  // The bed runs with hub.groups at its default (off): nothing new.
  rows.push(
    real === "off"
      ? { clause: clauses[7], ok: true, detail: "the bed's Den: off" }
      : {
          clause: clauses[7],
          ok: null,
          skip: "needs-hub-groups-off",
          why: "the bed's Den has hub.groups on",
          detail: `the bed's Den: ${real}${realError ? ` (${realError})` : ""}`,
        },
  );
  rows.push(...hubRows(list[0]?.result?.hubLeg ?? null));
  return rows;
}

/** The real-Hub leg's four rows: a skip names what's missing. */
export function hubRows(h) {
  const at = (i) => clauses[8 + i];
  const skipped = (why, detail) =>
    [0, 1, 2, 3].map((i) => ({ clause: at(i), ok: null, skip: why, detail }));
  if (!h) return skipped("needs-hub-leg", "the leg didn't run");
  if (h.skip) return skipped(h.skip, h.why ?? h.skip);
  if (h.error && !h.read) return skipped("error", h.error);
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
    ok:
      !!c.got &&
      c.got === c.want &&
      typeof c.status === "number" &&
      c.status < 400,
    detail: `compose ${c.got} (want ${c.want}), Hub answered ${c.status}`,
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
      : {
          clause: at(3),
          ok: off.state === "off" && off.requests === 0,
          detail: `read ${off.state}; groups requests to Hub since: ${off.requests}`,
        },
  );
  return rows;
}

export async function teardown(ctx) {
  if (ctx.agent(AGENT).state()) ctx.agent(AGENT).remove();
  if (D2) {
    const d = D2;
    D2 = null;
    await d.close();
  }
}
