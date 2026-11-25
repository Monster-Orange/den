/* eslint-env browser */
// gate/754.mjs: Den shows the work (issue 754). Read only.
// Asks the bed's own Den what Hub knows (GET /api/hub/work for the
// projects in view, GET /api/hub/agents-current for the agents listed),
// then, per cell, opens the home page on a project Hub has work for: the
// Work in Hub card is there above the repos and agents, with Needs you,
// Building and Blocked and a bar per vision. On the Agents page, every
// agent Hub names an item for shows "Working on …" or "Last on …".
// Hub's two routes ship in Hub 0.2.32: on an older Hub every clause skips
// ("needs-hub-work-routes"). With the bed connected to Hub, the no-Hub line
// skips ("needs-no-hub"); unconnected, it is the clause that runs.
export const issue = 754;
export const clauses = [
  "a Work in Hub card on the home page, above its services and agents, with Needs you, Building, Blocked and each vision's progress bar, opening Hub",
  "on the agents page, each agent's row shows its current Hub item (Working on / Last on) with a Kind chip, opening Hub",
  "with no Hub connected, or a 403, one quiet line linking to Connect and no card",
];
export const matrix = { browsers: ["chromium", "webkit"], widths: [1280, 390] };
export const timeoutMs = 120000;

async function json(ctx, path) {
  try {
    const r = await ctx.api(path);
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

export async function setup(ctx) {
  const scope = await json(ctx, "/api/scope");
  const names = Array.isArray(scope?.inView) ? scope.inView : [];
  const work = names.length
    ? await json(
        ctx,
        `/api/hub/work?projects=${encodeURIComponent(names.join(","))}`,
      )
    : null;
  const sessions = await json(ctx, "/api/sessions");
  const ids = (sessions?.sessions ?? [])
    .filter((s) => s.kind === "agent" && s.agent)
    .map((s) => s.agent);
  const cur = ids.length
    ? await json(
        ctx,
        `/api/hub/agents-current?agents=${encodeURIComponent(ids.join(","))}`,
      )
    : null;
  const withWork = (work?.projects ?? []).find((p) => p?.work)?.project ?? null;
  const withItem = Object.entries(cur?.agents ?? {})
    .filter(([, c]) => c?.item)
    .map(([id]) => id);
  return { hub: work?.hub ?? null, withWork, withItem, names };
}

export async function run(ctx, state) {
  const page = ctx.page;
  const tag = `${ctx.browser}-${ctx.width}`;
  const out = { ...state, tag };
  const project = state.withWork ?? state.names[0] ?? null;
  if (project && (state.withWork || state.hub !== "ok")) {
    await ctx.goto(page, `/?project=${encodeURIComponent(project)}`);
    await ctx.until(
      () =>
        page
          .locator("#hub-work-card, [data-hub-quiet]")
          .count()
          .then((n) => n > 0),
      15000,
    );
    out.card = await page.evaluate(() => {
      const card = document.getElementById("hub-work-card");
      const quiet = document.querySelector("[data-hub-quiet]");
      const below = document.querySelector("#repo-table, #agents-section");
      return {
        card: !!card,
        counts: card
          ? [...card.querySelectorAll("[data-count]")].map((e) =>
              e.getAttribute("data-count"),
            )
          : [],
        bars: card ? card.querySelectorAll("progress").length : 0,
        visions: card ? card.querySelectorAll("[data-vision]").length : 0,
        links: card
          ? [...card.querySelectorAll("a[href]")].every((a) =>
              /^https?:\/\//.test(a.getAttribute("href")),
            )
          : null,
        above:
          card && below
            ? !!(
                card.compareDocumentPosition(below) &
                Node.DOCUMENT_POSITION_FOLLOWING
              )
            : null,
        quiet: !!quiet,
        quietHref: quiet?.querySelector("a")?.getAttribute("href") ?? null,
        quietKind: quiet?.getAttribute("data-hub-quiet") ?? null,
      };
    });
    await ctx.shot(`home-${tag}`);
    out.homeShot = `home-${tag}`;
  }
  if (state.withItem.length) {
    await ctx.goto(page, "/agents");
    await ctx.until(
      () =>
        page
          .locator("[data-hubcurrent]")
          .count()
          .then((n) => n > 0),
      40000,
    );
    out.rows = await page.evaluate(() =>
      [...document.querySelectorAll("[data-hubcurrent]")].map((e) => ({
        source: e.getAttribute("data-hubcurrent"),
        kind: !!e.querySelector("[data-hw-kind]"),
        link: !!e.querySelector("a[href^='http']"),
      })),
    );
    await ctx.shot(`agents-${tag}`);
    out.agentsShot = `agents-${tag}`;
  }
  return out;
}

function rows(r) {
  if (!r)
    return clauses.map((clause) => ({
      clause,
      ok: false,
      detail: "no result",
    }));
  const old = r.hub === "ok" && !r.withWork && r.withItem.length === 0;
  const card =
    r.hub !== "ok"
      ? {
          clause: clauses[0],
          ok: null,
          skip: "needs-hub",
          detail: `hub: ${r.hub}`,
        }
      : old || !r.card
        ? {
            clause: clauses[0],
            ok: null,
            skip: "needs-hub-work-routes",
            detail:
              "Hub has no work for any project in view (its route ships in Hub 0.2.32)",
          }
        : {
            clause: clauses[0],
            ok:
              r.card.card &&
              r.card.counts.join(",") === "needs_you,building,blocked" &&
              r.card.bars === r.card.visions &&
              r.card.links === true &&
              r.card.above === true,
            detail: `${r.tag}: ${JSON.stringify(r.card)}`,
            evidence: [r.homeShot],
          };
  const agents =
    r.withItem.length === 0
      ? {
          clause: clauses[1],
          ok: null,
          skip: r.hub === "ok" ? "needs-hub-work-routes" : "needs-hub",
          detail: "Hub names no current item for any listed agent",
        }
      : {
          clause: clauses[1],
          ok:
            (r.rows ?? []).length > 0 &&
            r.rows.every(
              (x) =>
                (x.source === "working" || x.source === "recent") && x.link,
            ),
          detail: `${r.tag}: ${JSON.stringify(r.rows ?? [])}`,
          evidence: [r.agentsShot],
        };
  const quiet =
    r.hub === "ok"
      ? {
          clause: clauses[2],
          ok: null,
          skip: "needs-no-hub",
          detail: "the bed is connected to Hub",
        }
      : {
          clause: clauses[2],
          ok:
            !!r.card &&
            r.card.quiet &&
            !r.card.card &&
            // No Hub: the line links to Connect. A 403: the plan line,
            // or "Hub refused: <error>".
            (r.hub === "refused"
              ? r.card.quietKind === "plan" || r.card.quietKind === "refused"
              : r.card.quietHref === "/settings#agents.hub"),
          detail: `${r.tag}: ${JSON.stringify(r.card ?? null)}`,
          evidence: r.homeShot ? [r.homeShot] : [],
        };
  return [card, agents, quiet];
}

export function expect(cells) {
  const list = Array.isArray(cells) ? cells : [{ result: cells }];
  const per = list.map((c) => rows(c?.result));
  return clauses.map((clause, k) => {
    const got = per.map((r) => r[k]);
    if (got.every((r) => r.ok === null)) return got[0];
    const ran = got.filter((r) => r.ok !== null);
    return {
      clause,
      ok: ran.every((r) => r.ok === true),
      detail: ran.map((r) => r.detail).join(" | "),
      evidence: ran.flatMap((r) => r.evidence ?? []),
    };
  });
}
