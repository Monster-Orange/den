/* eslint-env browser */
// Live check for #335: a project's extra HTTP MCP servers are listed in Settings › Project and in doctor,
// by name and url only. Adding one is a held write that waits on the person's Allow, so on a bed with none
// the clauses that need a server are not run. Read only.
export const issue = 335;
export const clauses = [
  "the servers are listed in Settings (names and urls only)",
  "the servers are listed in doctor (names and urls only)",
  "an agent in project A gets the server and an agent in project B doesn't",
  "adding one is a held write with Allow",
  "the bearer appears in no file, env or log",
];
export const matrix = { browsers: ["chromium", "webkit"], widths: [1280] };
export const timeoutMs = 120000;

export async function setup(ctx) {
  const d = ctx.cli(["doctor"]);
  const lines = String(d.out + d.err)
    .split("\n")
    .filter((l) => /^\s*mcp server\s/.test(l))
    .map((l) => l.trim());
  return { doctorCode: d.code, doctor: lines };
}

export async function run(ctx, s) {
  await ctx.goto(ctx.page, "/settings");
  const row = ctx.page.locator(
    '.set-row[data-setting="workspace.mcp_servers"]',
  );
  await row.waitFor({ timeout: 15000 }).catch(() => {});
  await ctx.page
    .waitForSelector("[data-pmcp-none], [data-pmcp-list], [data-pmcp-error]", {
      timeout: 15000,
    })
    .catch(() => {});
  const seen = await ctx.page.evaluate(() => {
    const r = document.querySelector(
      '.set-row[data-setting="workspace.mcp_servers"]',
    );
    if (!r) return null;
    return {
      none: !!r.querySelector("[data-pmcp-none]"),
      error: r.querySelector("[data-pmcp-error]")?.textContent ?? null,
      servers: [...r.querySelectorAll("[data-pmcp]")].map((li) => ({
        name: li.getAttribute("data-pmcp"),
        text: li.textContent.trim(),
      })),
      text: r.innerText,
    };
  });
  await row.scrollIntoViewIfNeeded().catch(() => {});
  await ctx.shot(`mcp-servers-${ctx.browser}-${ctx.width}`);
  return { ...s, seen };
}

// A value that looks like a bearer (not a secrets.refs name) must never show.
const SECRETISH =
  /\b(bearer\s+\S{12,}|sk[-_][A-Za-z0-9]{12,}|[A-Za-z0-9+/_-]{40,})/i;

export function expect(cells) {
  const all = (f) => cells.every(({ result }) => f(result));
  const r0 = cells[0].result;
  const any =
    cells.some(({ result }) => result.seen?.servers.length > 0) ||
    r0.doctor.length > 0;
  return [
    {
      clause: clauses[0],
      ok: all(
        (r) =>
          !!r.seen &&
          !r.seen.error &&
          (r.seen.none || r.seen.servers.length > 0) &&
          !SECRETISH.test(r.seen.text),
      ),
      detail: cells
        .map(
          ({ cell, result: r }) =>
            `${cell.browser}: ${!r.seen ? "row missing" : r.seen.error ? `error ${r.seen.error}` : r.seen.none ? "none yet" : r.seen.servers.map((x) => x.text).join(", ")}`,
        )
        .join("; "),
      evidence: cells.map(
        ({ cell }) => `mcp-servers-${cell.browser}-${cell.width}.png`,
      ),
    },
    any
      ? {
          clause: clauses[1],
          ok: r0.doctor.length > 0 && !r0.doctor.some((l) => SECRETISH.test(l)),
          detail:
            r0.doctor.join(" | ") ||
            "Settings lists servers, doctor has no line",
        }
      : {
          clause: clauses[1],
          ok: null,
          skip: "needs-project-mcp-server",
          detail:
            "the bed has no project MCP server, so doctor has no line to show",
        },
    {
      clause: clauses[2],
      ok: null,
      skip: "needs-project-mcp-server",
      detail:
        "needs a server added on a person's Allow and an agent started in each of two projects",
    },
    {
      clause: clauses[3],
      ok: null,
      skip: "person",
      detail: "the add waits on the person's own Allow",
    },
    {
      clause: clauses[4],
      ok: null,
      skip: "needs-project-mcp-server",
      detail: "needs a server with a bearer, and a call through it",
    },
  ];
}
