// gate/714.mjs: gate slots held over MCP: told on grant, passed on when
// unclaimed, and leased (issue 714).
// Read only: it reads nothing and changes nothing, and asks for no slot.
// The bed's server has its own gate folder now (the bed-gate-dir
// proof on v0.4.85), so the folder no longer stops it. Two other things
// still do:
// - An MCP slot lives as long as the MCP server that asked. A check has
//   only one-shot CLI calls (`mcp --call`), whose process exits at once,
//   so its slot is taken back as gone before any clause could be seen.
//   The check needs a held MCP session on the bed (needs-mcp-session).
// - The lapse and claim clauses need claim_minutes and mcp_lapse_minutes
//   at 1; gate settings are person-only, and a fixture session counts as
//   an agent there (person). At the defaults (3 and 15 minutes) one run
//   would take over 20 minutes.
export const readOnly = true;

export const issue = 714;
// Issue 866 asked for this live check (714 shipped with unit tests only).
export const items = [714, 866];
export const clauses = [
  "a queued agent that idles is woken by the grant message; unclaimed after claim_minutes, the slot goes to the next in line, and the agent is re-queued and told",
  "an MCP slot not renewed and past its estimate lapses within the lapse time, and the next holder starts",
  "a renewed slot past its estimate keeps holding",
  "the lapse shows in the slot log and the bell, and the agent's next gate call says so",
];

export async function setup() {
  return {};
}

export async function run() {
  return {};
}

const MCP =
  "an MCP slot lives as long as the MCP server that asked; a check has only one-shot CLI calls (mcp --call), whose slot is taken back as gone when the call exits. Needs a held MCP session on the bed. Not asked";
const SETTINGS =
  "needs claim_minutes and mcp_lapse_minutes at 1 for the bed run; gate settings are person-only, and a fixture session counts as an agent there. Not asked";

export function expect() {
  return clauses.map((clause, i) => ({
    clause,
    ok: null,
    // Clause 1 (the grant message to an idle agent) and clause 4 (the
    // agent's next call says so) need the held session first; 2 and 3
    // need the short settings too.
    ...(i === 1 || i === 2
      ? { skip: "person", detail: `${SETTINGS}; and ${MCP}` }
      : { skip: "needs-mcp-session", detail: MCP }),
  }));
}
