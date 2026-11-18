// Live check for #390: after Den updates itself, it restarts each agent whose tools started on the old
// Den at its next idle (same conversation), once per update; server_agent.refresh_agents turns it off
// (default on); the bell names the agents refreshed.
// The setting is read, and saved with the value it already has (nothing changes). The restart clauses
// read the bed's own record of its last update (server-agent/update/state.json and refresh.json in its
// state folder): they run only on a bed that updated itself to the version it runs, else they skip.
export const issue = 390;
export const clauses = [
  "a setting turns it off (default on)",
  "after a recorded update, an idle agent whose tools predate it is restarted once",
  "the bell says which agents were refreshed",
];
export const timeoutMs = 60000;
const STATE = "server-agent/update/state.json";
const DONE = "server-agent/update/refresh.json";

const json = (t) => {
  try {
    return t ? JSON.parse(t) : null;
  } catch {
    return null;
  }
};

export async function setup(ctx) {
  const now = await ctx.api("/api/settings");
  return { value: now?.server_agent_refresh_agents };
}

export async function run(ctx, s) {
  // Saved as it is: a person's setting, so the bed's own session saves it.
  const saved = await ctx.fetch("/api/settings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ server_agent_refresh_agents: s.value }),
  });
  const after = await ctx.api("/api/settings");
  const version = (await ctx.api("/api/server-info"))?.version ?? null;
  const update = json(ctx.readBed(STATE));
  const done = json(ctx.readBed(DONE));
  const n = await ctx.api("/api/notifications");
  const bell = (n?.groups || [])
    .flatMap((g) => g.subjects || [])
    .filter((x) => String(x.subject).startsWith("record:den-refresh-"))
    .flatMap((x) => x.items || [])
    .map((i) => i.text);
  return {
    value: s.value,
    status: saved.status,
    afterValue: after?.server_agent_refresh_agents,
    version,
    update: update && { state: update.state, to: update.to, at: update.at },
    done,
    bell,
  };
}

export function expect(r) {
  const updated =
    r.update && r.update.state === "good" && r.update.to === r.version;
  const ids = Array.isArray(r.done?.ids) ? r.done.ids : [];
  const ours =
    updated && r.done?.to === r.update.to && r.done?.at === r.update.at;
  return [
    {
      clause: clauses[0],
      ok:
        typeof r.value === "boolean" &&
        r.status === 200 &&
        r.afterValue === r.value,
      detail: `server_agent_refresh_agents ${JSON.stringify(r.value)}, saved as it was: ${r.status}, then ${JSON.stringify(r.afterValue)}`,
    },
    !updated
      ? {
          clause: clauses[1],
          ok: null,
          skip: "needs-self-update",
          detail: `last update ${JSON.stringify(r.update)}; the bed runs ${r.version}`,
        }
      : !ours
        ? {
            clause: clauses[1],
            ok: null,
            skip: "needs-agent-on-old-tools",
            detail: `no agent was restarted for ${r.update.to} (${JSON.stringify(r.done)})`,
          }
        : {
            clause: clauses[1],
            ok: ids.length > 0 && new Set(ids).size === ids.length,
            detail: `restarted for ${r.update.to}: ${ids.join(", ")}`,
          },
    !ours || ids.length === 0
      ? {
          clause: clauses[2],
          ok: null,
          skip: "needs-agent-on-old-tools",
          detail: "no agent was restarted for this update",
        }
      : {
          clause: clauses[2],
          ok: r.bell.some((t) => ids.every((id) => t.includes(id))),
          detail: `bell: ${JSON.stringify(r.bell)}`,
        },
  ];
}
