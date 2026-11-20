// Live check for #265: agents.claude_ai_connectors: true lets an agent load the account's claude.ai connectors.
// One bed stub agent, made as gate-265-conn and removed in teardown. Read only: the switch is the org's
// (den.yml), never changed here. Den's half is what it launches the agent with: its --settings file
// (agent-files/<id>/settings.json). On: no disableClaudeAiConnectors, and every other MCP server kept out by
// name (enableAllProjectMcpServers false). Seeing a connector's tool needs Claude Code signed in to an
// account with one, which the bed's stub isn't.
export const issue = 265;
export const clauses = [
  "with the setting on, Den launches the agent so claude.ai connectors can load, and keeps every other MCP server out",
  "with the setting on, a relaunched agent loads the account's claude.ai connectors",
];
export const timeoutMs = 60000;
const ID = "gate-265-conn";

/** agents.claude_ai_connectors as the bed runs it: den.yml, else Den's default (off). */
function switchOf(ctx) {
  const yml = ctx.readBed("den.yml") ?? "";
  const sec = /^agents:\s*\n((?:[ \t]+.*\n?|\s*\n)*)/m.exec(yml);
  const set =
    sec && /^[ \t]+claude_ai_connectors:\s*(true|false)\b/m.exec(sec[1]);
  return set ? set[1] === "true" : false;
}

export async function setup(ctx) {
  const a = ctx.agent(ID);
  a.start("tester");
  return { runMs: await a.running(20000) };
}

export async function run(ctx, s) {
  const on = switchOf(ctx);
  const d = await ctx.api("/api/sessions");
  const me = (d?.sessions ?? []).find(
    (x) => x.kind === "agent" && x.agent === ID,
  );
  const raw = ctx.readBed(`agent-files/${ID}/settings.json`);
  let settings = null;
  try {
    settings = raw ? JSON.parse(raw) : null;
  } catch {
    settings = "unreadable";
  }
  return { ...s, on, runtime: me?.runtime ?? null, settings };
}

export function expect(r) {
  const st = r.settings && typeof r.settings === "object" ? r.settings : null;
  const seen = st
    ? `disableClaudeAiConnectors ${st.disableClaudeAiConnectors ?? "absent"}, enableAllProjectMcpServers ${st.enableAllProjectMcpServers ?? "absent"}, deniedMcpServers ${Array.isArray(st.deniedMcpServers) ? st.deniedMcpServers.length : "absent"}`
    : `settings file ${r.settings === "unreadable" ? "unreadable" : "missing"}`;
  let den;
  if (r.runtime !== "den-claude")
    den = {
      clause: clauses[0],
      ok: null,
      skip: "needs-claude-runtime",
      detail: `the bed's stub runs on ${r.runtime ?? "no session"}, not den-claude, so Den writes no Claude Code settings for it`,
    };
  else if (!r.on)
    den = {
      clause: clauses[0],
      ok: null,
      skip: "needs-connectors-on",
      detail: `the bed's den.yml has agents.claude_ai_connectors off (the default); with it off Den keeps them out: ${seen}`,
    };
  else
    den = {
      clause: clauses[0],
      ok:
        !!st &&
        st.disableClaudeAiConnectors !== true &&
        st.enableAllProjectMcpServers === false &&
        Array.isArray(st.deniedMcpServers) &&
        Array.isArray(st.disabledMcpjsonServers),
      detail: `agents.claude_ai_connectors on; ${r.runtime}: ${seen}`,
    };
  return [
    den,
    {
      clause: clauses[1],
      ok: null,
      skip: "needs-claude-account",
      detail:
        "a connector's tool shows only in Claude Code signed in to an account with claude.ai connectors; the bed's stub agent is neither",
    },
  ];
}

export async function teardown(ctx) {
  if (ctx.agent(ID).state()) ctx.agent(ID).remove();
}
