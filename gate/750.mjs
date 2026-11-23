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

export async function setup(ctx) {
  const a = ctx.agent(AGENT);
  a.start("tester");
  return { runMs: await a.running(20000) };
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
      .locator('.den-grph[data-group="g750-group"]')
      .waitFor({ timeout: 20000 })
      .catch(() => {});
    await p
      .locator(`[data-group="g750-group"] .agst [data-act="tools-restart"]`)
      .waitFor({ timeout: 10000 })
      .catch(() => {});
    out.groups = await p.evaluate((agent) => {
      const g = document.querySelector('.agg[data-group="g750-group"]');
      const h = g?.querySelector(".den-grph");
      const name = h?.querySelector("a.den-grph-name");
      const act = h?.querySelector("a.den-grph-act");
      const sw = document.querySelector("[data-by-switch]");
      const none = document.querySelector(".agg[data-group-none]");
      const row = g?.querySelector(".agst, .agr");
      const wrap = g?.querySelector(`.agst[data-agent="${agent}"]`);
      return {
        switch: sw
          ? [...sw.querySelectorAll("button[data-by]")].map((b) => [
              b.dataset.by,
              b.getAttribute("aria-pressed"),
            ])
          : null,
        lead: h?.querySelector(".den-grph-lead")?.textContent?.trim() ?? null,
        leadMark: !!h?.querySelector(".den-grph-lead .den-grph-mark"),
        nameHref: name?.getAttribute("href") ?? null,
        nameTarget: name?.getAttribute("target") ?? null,
        actHref: act?.getAttribute("href") ?? null,
        actTarget: act?.getAttribute("target") ?? null,
        actText: act?.textContent?.trim() ?? null,
        memberRow: !!row && (row.textContent ?? "").length > 0,
        memberInGroup: !!g?.querySelector(`.agr`) && !!wrap,
        notInGroup: none
          ? (none.querySelector(".wsh")?.textContent ?? "").trim()
          : null,
        unreach:
          wrap?.querySelector('[data-mcp-failed="hub"]')?.textContent?.trim() ??
          null,
        restart: !!wrap?.querySelector(
          '.agacts button[data-act="tools-restart"]',
        ),
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
        .locator(".agnote[data-note^='groups-']")
        .waitFor({ timeout: 15000 })
        .catch(() => {});
      lines[k] = await p.evaluate(() => {
        const n = document.querySelector(".agnote[data-note^='groups-']");
        return {
          note: n?.getAttribute("data-note") ?? null,
          text: n?.textContent?.trim() ?? null,
          link: n?.querySelector("a")?.getAttribute("href") ?? null,
          linkText: n?.querySelector("a")?.textContent?.trim() ?? null,
          groupUi: document.querySelectorAll(
            "[data-by-switch], .den-grph, .den-grph-act",
          ).length,
          byProject: document.querySelectorAll(".wsg[data-ws]").length,
        };
      });
      await ctx.shotOf(p, `line-${k}-${tag}`);
    }
    out.lines = lines;
  } finally {
    await p.close().catch(() => {});
  }
  // The bed's own Hub, through Den (no page routes).
  const real = await ctx.api("/api/hub/groups").catch(() => null);
  out.real = real?.state ?? null;
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
      detail: `the bed's Hub: ${real}`,
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
          detail: `the bed's Den: ${real}`,
        },
  );
  return rows;
}

export async function teardown(ctx) {
  if (ctx.agent(AGENT).state()) ctx.agent(AGENT).remove();
}
