// gate/659.mjs: Claude Code's folder-trust question is never answered by
// Den's typing, and the agent's row, pane and bell name it.
//
// Clause 1: a running stub draws Claude Code 2.1.329's trust question
// (the captured screen in tests/fixtures/claude-code-screens/1-trust.raw,
// without its colours: "No, exit" highlighted first, so a bare Enter would
// pick it). A message from the page (POST .../agents/<id>/say) then
// answers 409 dialog_open, and nothing at all reaches the stub's terminal
// (no text, no Enter). The stub then clears its screen.
//
// Clauses 2 and 3 skip (needs-stub-trust-start): Den looks for the trust
// question only while an agent's conversation isn't written yet (or after
// it saw the question), and the bed's stub writes its transcript the
// moment it starts. So Den never looks at the stub's screen for it. The
// bed would need a stub mode that, on start, draws the trust screen and
// writes no transcript until "Yes" is chosen, and on "No, exit" exits 1
// with none written.
export const issue = 659;
export const clauses = [
  "Den never answers the folder-trust question: a message to an agent showing it answers 409 dialog_open and types nothing, not even Enter",
  'while the folder-trust question is on screen, the agent\'s row, pane and bell say "Waiting: trust this folder?"',
  "after a No, the row says \"Didn't start: this folder isn't trusted. Resume and choose Yes.\"",
];
export const timeoutMs = 120000;

const NAME = "gate-659-trust";
const PROBE = "gate 659 probe: a message while the trust question shows";
// Claude Code 2.1.329's trust question, as the stub's /print takes it
// (JSON string escapes, one line). "No, exit" is highlighted (❯).
const TRUST = [
  "\\u001b[2J\\u001b[H",
  " Accessing workspace:\\r\\n\\r\\n",
  " /tmp/project\\r\\n\\r\\n",
  " Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source\\r\\n",
  " project, or work from your team). If not, take a moment to review what's in this folder first.\\r\\n\\r\\n",
  " Claude Code'll be able to read, edit, and execute files here.\\r\\n\\r\\n",
  " Security guide\\r\\n\\r\\n",
  " \\u276f No, exit\\r\\n",
  "   Yes, I trust this folder\\r\\n\\r\\n",
  " Enter to confirm \\u00b7 Esc to cancel\\r\\n",
].join("");
const PROMPT = "\\u001b[2J\\u001b[H> ";
const NEEDS =
  "the bed's stub writes its conversation the moment it starts, and Den looks for the trust question only before an agent's conversation exists; the bed needs a stub mode that draws the trust screen on start and writes no transcript until Yes (exit 1 with none on \"No, exit\")";

const parse = (b) => {
  if (b && typeof b === "object") return b;
  try {
    return JSON.parse(b);
  } catch {
    return null;
  }
};

/** Everything typed into the stub's terminal since `since`, or null. */
async function typedOf(a, since) {
  try {
    const rows = await a.typed({ since });
    if (!Array.isArray(rows)) return null;
    return rows.map((x) => `${x?.text ?? ""}${x?.enter ? "\\r" : ""}`).join("");
  } catch {
    return null;
  }
}

export async function setup(ctx) {
  const a = ctx.agent(NAME);
  const s = { start: a.start("tester")?.code ?? null };
  s.runningMs = await a.running(30000);
  await ctx.sleep(2500);
  return s;
}

export async function run(ctx, s) {
  const a = ctx.agent(NAME);
  const r = {
    start: s?.start ?? null,
    running: s?.runningMs !== null && s?.runningMs !== undefined,
  };
  const rec = parse(ctx.readBed(`state:agents/${NAME}.json`));
  r.ws = rec?.workspace ?? null;
  r.runtime = rec?.runtime ?? null;
  if (!r.running || !r.ws) return r;
  a.print(TRUST);
  // The stub takes its control file every 500 ms: let it draw.
  await ctx.sleep(3000);
  const since = Date.now();
  const res = await ctx.fetch(
    `/api/workspaces/${encodeURIComponent(r.ws)}/agents/${encodeURIComponent(NAME)}/say`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: PROBE }),
    },
  );
  r.status = res.status;
  const body = parse(res.body);
  r.code = body?.code ?? null;
  r.error = typeof body?.error === "string" ? body.error.slice(0, 200) : null;
  await ctx.sleep(2000);
  r.typed = await typedOf(a, since);
  a.print(PROMPT);
  ctx.log?.(`659: ${JSON.stringify(r)}`);
  return r;
}

export async function teardown(ctx) {
  try {
    const a = ctx.agent(NAME);
    if (a.state()) a.remove();
  } catch {
    /* none */
  }
}

export function expect(r) {
  const y = r ?? {};
  const ok =
    y.running === true &&
    !!y.ws &&
    y.status === 409 &&
    y.code === "dialog_open" &&
    y.typed === "";
  const detail = !y.running
    ? `the ${NAME} stub did not run (start ${y.start})`
    : `runtime ${y.runtime}; ws ${y.ws}; status ${y.status} ${y.code}: ${y.error}; typed ${y.typed === null ? "(the stub can't say)" : JSON.stringify(y.typed)}`;
  return [
    { clause: clauses[0], ok, detail },
    {
      clause: clauses[1],
      ok: null,
      skip: "needs-stub-trust-start",
      detail: NEEDS,
    },
    {
      clause: clauses[2],
      ok: null,
      skip: "needs-stub-trust-start",
      detail: NEEDS,
    },
  ];
}
