// A fake bed for gate/265.mjs (tests/unit/test-infra/gate-265-runner.test.ts):
// one stub agent, the bed's den.yml and the --settings file Den wrote for
// it. `on`: agents.claude_ai_connectors in den.yml (undefined: not set).
// `runtime`: the stub's runtime. `den`: "fixed" (as den#265 built it) or
// "old" (connectors disabled whatever the switch says). Invented names only.
const ID = "gate-265-conn";

export function fakeBed({ on, runtime = "den-claude", den = "fixed" } = {}) {
  let agent = null;
  const yml =
    on === undefined
      ? "agents:\n  max_concurrent: 4\n"
      : `agents:\n  max_concurrent: 4\n  claude_ai_connectors: ${on}\n`;
  const settings =
    on && den === "fixed"
      ? {
          permissions: { deny: [] },
          deniedMcpServers: [{ serverName: "person-tool" }],
          enableAllProjectMcpServers: false,
          disabledMcpjsonServers: [],
        }
      : { permissions: { deny: [] }, disableClaudeAiConnectors: true };
  const ctx = {
    url: "http://bed.invalid",
    readBed(rel) {
      if (rel === "den.yml") return yml;
      if (rel === `agent-files/${ID}/settings.json`)
        return agent ? JSON.stringify(settings) : null;
      return null;
    },
    async api(p) {
      if (p === "/api/sessions")
        return {
          sessions: agent
            ? [
                {
                  id: "s1",
                  kind: "agent",
                  agent: ID,
                  workspace: "north",
                  runtime,
                },
              ]
            : [],
        };
      return {};
    },
    agent() {
      return {
        start() {
          agent = ID;
        },
        async running() {
          return 10;
        },
        state() {
          return agent ? { id: ID } : null;
        },
        remove() {
          agent = null;
        },
      };
    },
  };
  return { ctx, removed: () => agent === null };
}
