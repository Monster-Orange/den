/**
 * Issue 750 (G3): the agents page's By group view, beside By project.
 * Pure (no DOM): agents-page.js draws with it, and unit tests read it.
 *
 * Groups are a Den Hub feature. Den reads them from Hub (GET
 * /api/hub/groups: hub-groups-routes.ts) and stores none. Without Hub's
 * groups the page has one line saying why (groupsLineHtml) and no group
 * UI: By project as today.
 *
 * Each group gets the kit's header (group-header.js): its name opens it in
 * Hub, its lead is marked, and Message group opens Hub's composer in a new
 * tab (the person sends with their own Hub sign-in). Its members on this
 * Den are matched by agent_id, the lead first; the rest of the list sits
 * under "Not in a group".
 *
 * Issue 750 step 3 (and 749's page part): a running agent whose Hub tools
 * failed to load says "Can't reach Hub" on its row, with Restart.
 */
import { groupHeaderHtml } from "/kit/group-header.js";

const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );

/**
 * Issue 750 step 3: Restart on the row of a running agent whose session
 * failed to load a server's tools (issue 749's mcpFailed, the one source;
 * its tag says "Can't reach Hub"). Restart loads them again on the same
 * conversation (data-act="tools-restart", the pane bar's own action). None
 * while Den restarts it already (toolsRestarting), or for a stopped agent.
 */
export function toolsRestartHtml(r, t) {
  if (r?.kind !== "agent" || r.toolsRestarting) return "";
  if (r.state !== "running" && r.state !== "stopping") return "";
  if (!Array.isArray(r.mcpFailed) || !r.mcpFailed.length) return "";
  const name = esc(t("ag.mcp.restartName", { id: r.agent }));
  return `<button type="button" class="den-btn sm" data-act="tools-restart" aria-label="${name}" title="${name}">${esc(t("ag.mcp.restart"))}</button>`;
}

/** Where Connect is (Settings › Agents › Hub). */
export const CONNECT_HREF = "/settings#agents.hub";

/** Whether the page offers By group: Hub answered with its groups. */
export function groupsOffered(read) {
  return read?.state === "ok" && Array.isArray(read.groups);
}

/** An http(s) address, else null. */
function httpUrl(v) {
  try {
    const u = new URL(String(v));
    return u.protocol === "https:" || u.protocol === "http:" ? String(v) : null;
  } catch {
    return null;
  }
}

const NEW_TAB = ' target="_blank" rel="noopener noreferrer"';

/**
 * The one line above the list when groups aren't offered (Spec GR v6,
 * frame g-den-nohub); By project shows as today, with no By group switch
 * and no Message group. By Hub's answer (its code, never its words):
 *   none         Groups come with Den Hub.            Connect Den Hub
 *   unavailable  not in the company's Den Hub plan.   Open Hub
 *   refused      a guest in the company: not shown here.
 *   rejected, unreachable: Can't reach Den Hub.       Try again
 * Not read yet, or Hub's groups: nothing.
 */
export function groupsLineHtml(read, t) {
  const st = read?.state;
  const line = (note, words, act = "") =>
    `<div class="agnote quiet" data-note="${note}" role="status">${esc(t(words))}${act ? ` ${act}` : ""}</div>`;
  if (st === "none")
    return line(
      "groups-hub",
      "ag.grp.noHub",
      `<a class="den-btn sm" href="${CONNECT_HREF}">${esc(t("ag.grp.connect"))}</a>`,
    );
  if (st === "unavailable") {
    const hub = httpUrl(read.hub);
    return line(
      "groups-plan",
      "ag.grp.notInPlan",
      hub
        ? `<a class="den-btn sm" href="${esc(hub)}"${NEW_TAB}>${esc(t("ag.grp.openHub"))}</a>`
        : "",
    );
  }
  if (st === "refused") return line("groups-guest", "ag.grp.guest");
  if (st === "rejected" || st === "unreachable")
    return line(
      "groups-unreachable",
      "ag.grp.unreachable",
      `<button type="button" class="den-btn sm" data-act="groups-retry">${esc(t("ag.grp.retry"))}</button>`,
    );
  return "";
}

/** By project | By group, only when Hub's groups are there. */
export function viewSwitchHtml(read, by, t) {
  if (!groupsOffered(read)) return "";
  const b = (k) =>
    `<button type="button" data-by="${k}" aria-pressed="${by === k}">${esc(t(`ag.by.${k}`))}</button>`;
  return (
    `<div class="seg agby" role="group" aria-label="${esc(t("ag.by.label"))}" data-by-switch>` +
    b("project") +
    b("group") +
    `</div>`
  );
}

/**
 * The list's rows by group: each group's members on this Den (by
 * agent_id; the lead first, then Hub's order), and every other row (a
 * plain session too) under Not in a group. An agent in two groups shows in
 * both.
 */
export function byGroupSections(rows, groups) {
  const inSome = new Set();
  const out = (groups ?? []).map((g) => {
    // Only this Den's own agents (`here`): an agent_id may be another
    // person's agent.
    const ids = (g.members ?? [])
      .filter((m) => m.kind === "agent" && m.agentId && m.here)
      .map((m) => m.agentId);
    const lead =
      g.lead?.kind === "agent" && g.lead.here ? g.lead.agentId : undefined;
    const order = lead ? [lead, ...ids.filter((x) => x !== lead)] : ids;
    const mine = [];
    for (const id of order) {
      const r = rows.find((x) => x.kind === "agent" && x.agent === id);
      if (r && !mine.includes(r)) {
        mine.push(r);
        inSome.add(r);
      }
    }
    return { group: g, rows: mine };
  });
  return { groups: out, none: rows.filter((r) => !inSome.has(r)) };
}

/**
 * The list's body in the By group view. Hub has none: "No groups yet",
 * with Open Groups in Hub (groupsUrl).
 */
export function groupsViewHtml(rows, groups, { t, rowHtml, groupsUrl }) {
  const s = byGroupSections(rows, groups);
  const open = httpUrl(groupsUrl);
  const head = s.groups.length
    ? ""
    : `<div class="agnote" data-note="no-groups" role="status">${esc(t("ag.grp.noGroups"))}` +
      (open
        ? ` <a class="den-btn sm" href="${esc(open)}"${NEW_TAB}>${esc(t("ag.grp.openGroups"))}</a>`
        : "") +
      `</div>`;
  const body = s.groups
    .map(
      ({ group: g, rows: mine }) =>
        `<div class="wsg agg" data-group="${esc(g.slug)}">` +
        groupHeaderHtml({
          name: g.name,
          slug: g.slug,
          href: g.open,
          openLabel: t("ag.grp.open", { group: g.name }),
          lead: g.lead ? t("ag.grp.lead", { name: g.lead.name }) : null,
          count: mine.length,
          action: g.compose
            ? {
                label: t("ag.grp.message"),
                href: g.compose,
                name: t("ag.grp.messageName", { group: g.name }),
              }
            : null,
        }) +
        (mine.length
          ? mine.map((r) => rowHtml(r)).join("")
          : `<div class="none">${esc(t("ag.grp.empty"))}</div>`) +
        `</div>`,
    )
    .join("");
  const rest = s.none.length
    ? `<div class="wsg agg" data-group-none><div class="wsh"><span>${esc(t("ag.grp.notIn"))}</span><span>${esc(s.none.length)}</span></div>` +
      s.none.map((r) => rowHtml(r)).join("") +
      `</div>`
    : "";
  return head + body + rest;
}
