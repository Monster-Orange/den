/* eslint-env browser */
// Live check for #352: each of a project's extra MCP servers on Settings has Change and Remove. Both are
// held writes that wait on the person's own Allow, so nothing is pressed. On a bed with no server the row
// has nothing to change and the clauses are not run. Read only.
export const issue = 352;
export const clauses = [
  "the Settings row has the matching actions: change and remove each server",
  "removing a server takes it out of the next agent start; neither runs before Allow",
  "an update to the url reaches the next start",
];
export const matrix = { browsers: ["chromium", "webkit"], widths: [1280] };
export const timeoutMs = 90000;

// Read only (issue 845): reads Settings › Project's MCP server row and its buttons.
export const readOnly = true;

export async function setup() {
  return {};
}

export async function run(ctx) {
  await ctx.goto(ctx.page, "/settings");
  await ctx.page
    .waitForSelector("[data-pmcp-none], [data-pmcp-list], [data-pmcp-error]", {
      timeout: 20000,
    })
    .catch(() => {});
  const r = await ctx.page.evaluate(() => {
    const row = document.querySelector(
      '.set-row[data-setting="workspace.mcp_servers"]',
    );
    if (!row) return { row: false, servers: [] };
    return {
      row: true,
      servers: [...row.querySelectorAll("[data-pmcp]")].map((li) => {
        const n = li.getAttribute("data-pmcp");
        return {
          name: n,
          edit: !!row.querySelector(`[data-pmcp-edit="${CSS.escape(n)}"]`),
          remove: !!row.querySelector(`[data-pmcp-remove="${CSS.escape(n)}"]`),
        };
      }),
    };
  });
  await ctx.page
    .locator('.set-row[data-setting="workspace.mcp_servers"]')
    .scrollIntoViewIfNeeded()
    .catch(() => {});
  await ctx.shot(`mcp-actions-${ctx.browser}-${ctx.width}`);
  return r;
}

export function expect(cells) {
  const any = cells.some(({ result }) => result.servers.length > 0);
  const d = cells
    .map(
      ({ cell, result: r }) =>
        `${cell.browser}: ${!r.row ? "row missing" : r.servers.map((s) => `${s.name} change ${s.edit} remove ${s.remove}`).join(", ") || "no server"}`,
    )
    .join("; ");
  return [
    any
      ? {
          clause: clauses[0],
          ok: cells.every(
            ({ result: r }) =>
              r.row && r.servers.every((s) => s.edit && s.remove),
          ),
          detail: d,
          evidence: cells.map(
            ({ cell }) => `mcp-actions-${cell.browser}-${cell.width}.png`,
          ),
        }
      : {
          clause: clauses[0],
          ok: null,
          skip: "needs-project-mcp-server",
          detail: d,
        },
    {
      clause: clauses[1],
      ok: null,
      skip: "person",
      detail: "project_mcp_remove waits on the person's own Allow",
    },
    {
      clause: clauses[2],
      ok: null,
      skip: "person",
      detail: "project_mcp_update waits on the person's own Allow",
    },
  ];
}
