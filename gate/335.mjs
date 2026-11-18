/* eslint-env browser */
// Live check for #335: a project's extra HTTP MCP servers are listed in Settings › Project and in doctor,
// by name and url only; an agent in the server's project gets it and an agent in another project doesn't;
// and the bearer is in no file or log. Adding one is a held write that waits on the person's Allow, so the
// check uses the bed's own server (SERVER, bearer ref REF, in the bed's default project) and never adds one.
//
// Setup starts two stub agents under this check's own names (gate335-*): one in the server's project, one
// in OTHER (ctx.agent(id, { workspace })). It reads each one's record and MCP config, then has the harness
// search the agents' files, the session files, Den's logs and each stub's transcript (ctx.transcriptPath)
// for the bearer (ctx.secretSeen). The harness
// holds the test value and answers with paths only: the check never sees, prints or writes it, and never
// reads a process's environment. That the value never reaches the agent's env is a Den unit test of what
// the session is launched with (tests/unit/agents/project-mcp.test.ts). Clause 6 (issue 473) runs A's
// headers helper in A's own session (handle.sh), with Den's server in reach and out of it. Teardown
// removes both stubs.
export const issue = 335;
export const clauses = [
  "the servers are listed in Settings (names and urls only)",
  "the servers are listed in doctor (names and urls only)",
  "an agent in project A gets the server and an agent in project B doesn't",
  "adding one is a held write with Allow",
  "the bearer appears in no file, env or log",
  "the agent's call carries the bearer header, through the headers helper",
];
export const matrix = { browsers: ["chromium", "webkit"], widths: [1280] };
export const timeoutMs = 120000;

const SERVER = "gate-mcp";
const SERVER_URL = "http://127.0.0.1:7898/mcp";
const REF = "gate_mcp";
const OTHER = "proj-gate";

/** The doctor line for SERVER: the project it is in. */
function serverLine(lines) {
  const l = lines.find((x) =>
    new RegExp(`^mcp server\\s+\\S+\\s+[\\w.-]+: ${SERVER} `).test(x),
  );
  if (!l) return null;
  return { project: /^mcp server\s+\S+\s+([\w.-]+):/.exec(l)[1] };
}

/** A stub under this check's name, started (in `workspace` when given) and running; recorded for teardown. */
async function stub(ctx, state, role, workspace) {
  const name = `gate335-${role}-${state.tag}`;
  const ctl = workspace
    ? await ctx.agent(name, { workspace })
    : await ctx.agent(name);
  // The handle says the project it acts in (unset: a harness with no project option).
  const a = { name, id: ctl?.id ?? name, ctl, workspace: ctl?.workspace };
  state.made.push(a);
  // A refused start (agents.max_concurrent reached) says so here, not later as a missing file.
  const r = await ctl.start("tester");
  if (r && typeof r.code === "number" && r.code !== 0)
    throw new Error(
      `${name}: the bed refused to start it (agents.max_concurrent?): ${String(r.all ?? r.err ?? r.out ?? "").slice(0, 200)}`,
    );
  await ctl.running(20000);
  return a;
}

/** What the agent's record and MCP config say: its project, and its MCP servers by name. */
async function seenBy(ctx, a) {
  // Den's state folder, not the bed's own: "state:" (ctx.readBed).
  const rec = await ctx.readBed(`state:agents/${a.id}.json`);
  const cfg = await ctx.readBed(`state:agent-files/${a.id}/mcp.json`);
  let servers = null;
  try {
    servers = cfg ? (JSON.parse(cfg).mcpServers ?? {}) : null;
  } catch {
    servers = null;
  }
  let workspace = null;
  try {
    workspace = rec ? (JSON.parse(rec).workspace ?? null) : null;
  } catch {
    workspace = null;
  }
  const s = servers?.[SERVER];
  return {
    workspace,
    record: rec !== null,
    config: cfg !== null,
    names: servers ? Object.keys(servers) : [],
    server: s
      ? {
          url: s.url ?? null,
          helper: /\bmcp headers ['"]?gate-mcp['"]?$/.test(
            String(s.headersHelper ?? ""),
          ),
          // The file holds the helper, never a header of its own.
          headers: "headers" in s,
        }
      : null,
  };
}

/** A fetch answer's body as text (ctx.fetch keeps it as text or JSON). */
const textOf = (r) =>
  typeof r?.body === "string" ? r.body : JSON.stringify(r?.body ?? {});

/**
 * Clause 6 (issue 473): the helper Den wrote into A's MCP config, run in A's
 * own session (handle.sh), as its MCP client runs it. It must print the
 * header, which only Den's running server can hand it (the agent's env never
 * holds the bearer). Then the same helper with Den's server out of its reach
 * (DEN_BIND_HOST=::1, where Den doesn't listen): it must fail and say Den
 * isn't running, never falling back to a store or an env of its own. The
 * session prints only "header=yes|no" and a count, never the header. Den's
 * side: GET /api/mcp-servers/bearers says it can serve SERVER's bearer
 * (never a value), and POST /api/agents/self/mcp-headers refuses a person
 * (403: an agent's own token only).
 */
async function headerCheck(ctx, a) {
  const out = { route: null, self: null, up: null, down: null, noSh: false };
  if (typeof ctx.fetch === "function") {
    try {
      const r = await ctx.fetch("/api/mcp-servers/bearers");
      const text = textOf(r);
      let servers = [];
      try {
        servers = JSON.parse(text).servers ?? [];
      } catch {
        servers = [];
      }
      const sv = servers.find((x) => x?.name === SERVER);
      out.route = {
        status: r.status,
        listed: !!sv,
        served: sv?.served === true,
        why: sv?.why ? String(sv.why).slice(0, 200) : null,
        secretish: SECRETISH.test(text),
      };
      const p = await ctx.fetch("/api/agents/self/mcp-headers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: SERVER }),
      });
      out.self = { status: p.status, secretish: SECRETISH.test(textOf(p)) };
    } catch (e) {
      out.route = { error: String(e?.message ?? e).slice(0, 200) };
    }
  }
  if (typeof a.ctl.sh !== "function") {
    out.noSh = true;
    return out;
  }
  let helper = null;
  try {
    const cfg = await ctx.readBed(`state:agent-files/${a.id}/mcp.json`);
    helper = JSON.parse(cfg ?? "").mcpServers?.[SERVER]?.headersHelper ?? null;
  } catch {
    helper = null;
  }
  if (!helper || !/\bmcp headers ['"]?gate-mcp['"]?$/.test(helper)) {
    out.noHelper = true;
    return out;
  }
  const verdict = (pre) =>
    `out=$(${pre}${helper} 2>/dev/null); c=$?; ` +
    `case "$out" in *'"Authorization":"Bearer '?*) h=yes;; *) h=no;; esac; ` +
    `n=$(${pre}${helper} 2>&1 >/dev/null | grep -c "isn't running"); ` +
    `echo "code=$c header=$h down=$n"`;
  const parse = (r) => {
    const t = String(r?.out ?? r?.all ?? "");
    const m = /code=(\d+) header=(yes|no) down=(\d+)/.exec(t);
    return m
      ? { code: Number(m[1]), header: m[2] === "yes", says: Number(m[3]) > 0 }
      : { bad: t.slice(0, 120) };
  };
  out.up = parse(await a.ctl.sh(verdict("")));
  out.down = parse(await a.ctl.sh(verdict("DEN_BIND_HOST=::1 ")));
  return out;
}

/** Clauses 3 and 5, both through the two stubs. Never throws: an error is the clause's own answer. */
async function agents(ctx, state) {
  const out = { a: null, b: null, error: null, seen: null };
  if (typeof ctx.secretSeen !== "function") out.noSecretSeen = true;
  try {
    const a = await stub(ctx, state, "a");
    const b = await stub(ctx, state, "b", OTHER);
    out.bHandle = b.workspace ?? null;
    out.a = await seenBy(ctx, a);
    out.b = await seenBy(ctx, b);
    // Clause 6, while A runs: its helper, in its own session.
    out.header = await headerCheck(ctx, a);
    for (const x of [a, b]) await x.ctl.stop();
    if (!out.noSecretSeen) {
      // Each agent's files and record, every session's files, Den's logs (all in Den's
      // state folder: "state:"), and each stub's transcript (the runtime's own file).
      const dirs = [
        ...state.made.flatMap((x) => [
          `state:agent-files/${x.id}`,
          `state:agents/${x.id}.json`,
        ]),
        "state:sessions",
        "state:logs",
      ];
      const noTranscriptPath = typeof ctx.transcriptPath !== "function";
      const transcripts = noTranscriptPath
        ? []
        : await Promise.all(
            state.made.map(async (x) => ({
              id: x.id,
              path: (await ctx.transcriptPath(x.id)) || null,
            })),
          );
      const paths = [
        ...dirs,
        ...transcripts.map((t) => t.path).filter(Boolean),
      ];
      const r = await ctx.secretSeen(REF, paths);
      out.seen = {
        paths,
        // Files this check read or was pointed at: a search that read fewer missed them.
        known:
          [out.a, out.b].reduce(
            (n, s) => n + (s?.record ? 1 : 0) + (s?.config ? 1 : 0),
            0,
          ) + transcripts.filter((t) => t.path).length,
        noTranscriptPath,
        noTranscript: transcripts.filter((t) => !t.path).map((t) => t.id),
        searched: Number(r?.searched) || 0,
        hits: (Array.isArray(r?.hits) ? r.hits : []).map(String),
        error: r?.error ? String(r.error).slice(0, 200) : null,
      };
    }
  } catch (e) {
    out.error = String(e?.message ?? e).slice(0, 300);
  }
  return out;
}

export async function setup(ctx) {
  const d = ctx.cli(["doctor"]);
  const lines = String(d.out + d.err)
    .split("\n")
    .filter((l) => /^\s*mcp server\s/.test(l))
    .map((l) => l.trim());
  const state = {
    doctorCode: d.code,
    doctor: lines,
    tag: Date.now().toString(36),
    made: [],
  };
  const line = serverLine(lines);
  state.line = line;
  if (line) state.agents = await agents(ctx, state);
  return state;
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
  const { made: _made, ...rest } = s;
  return { ...rest, seen };
}

export async function teardown(ctx, state) {
  for (const a of state?.made ?? []) {
    try {
      await a.ctl.stop?.();
      await (a.ctl.remove ?? a.ctl.dispose ?? a.ctl.close)?.call(a.ctl);
    } catch {
      /* best effort */
    }
  }
}

// A value that looks like a bearer (not a secrets.refs name) must never show.
const SECRETISH =
  /\b(bearer\s+\S{12,}|sk[-_][A-Za-z0-9]{12,}|[A-Za-z0-9+/_-]{40,})/i;

const NO_SERVER = {
  ok: null,
  skip: "needs-project-mcp-server",
  detail: `doctor lists no ${SERVER}: the bed has no project MCP server for this check`,
};

function inA(r) {
  const g = r.agents;
  if (!r.line) return { clause: clauses[2], ...NO_SERVER };
  if (g.error) return { clause: clauses[2], ok: false, detail: g.error };
  // A handle with no .workspace: the harness has no project option.
  if (g.bHandle === null)
    return {
      clause: clauses[2],
      ok: null,
      skip: "needs-harness-agent-workspace",
      detail: `ctx.agent(id, { workspace: "${OTHER}" }) gave a handle with no project`,
    };
  const a = g.a.server;
  return {
    clause: clauses[2],
    ok:
      g.a.workspace === r.line.project &&
      g.b.workspace === OTHER &&
      !!a &&
      a.url === SERVER_URL &&
      a.helper &&
      !a.headers &&
      g.b.config &&
      !g.b.names.includes(SERVER),
    detail:
      `A (${g.a.workspace}): ${a ? `${SERVER} ${a.url}${a.helper ? ", headers by helper" : ", no headers helper"}${a.headers ? ", headers written in the file" : ""}` : `no ${SERVER} in ${g.a.config ? g.a.names.join(", ") || "an empty config" : "no mcp.json"}`}; ` +
      `B (${g.b.workspace}): ${g.b.config ? (g.b.names.includes(SERVER) ? `has ${SERVER}` : `no ${SERVER} (${g.b.names.join(", ") || "none"})`) : "no mcp.json"}`,
  };
}

function noBearer(r) {
  const g = r.agents;
  const c = { clause: clauses[4] };
  if (!r.line) return { ...c, ...NO_SERVER };
  if (g.error) return { ...c, ok: false, detail: g.error };
  if (g.noSecretSeen)
    return {
      ...c,
      ok: null,
      skip: "needs-harness-secretSeen",
      detail:
        "ctx has no secretSeen(ref, paths), to search files for the bearer without reading it",
    };
  const x = g.seen;
  // The only skip on a full harness: the bed holds no test value behind the ref.
  if (x.error)
    return {
      ...c,
      ok: null,
      skip: "needs-test-bearer",
      detail: `no test value behind secrets.refs.${REF}: ${x.error}`,
    };
  // A transcript not searched is said, never passed over silently.
  const gaps = x.noTranscriptPath
    ? "; needs-harness-transcriptPath: the transcripts were not searched"
    : x.noTranscript?.length
      ? `; transcript not found: ${x.noTranscript.join(", ")}`
      : "";
  // Fewer files searched than this check itself read: some paths resolved to nothing.
  const short = x.searched > 0 && x.searched < (x.known ?? 0);
  return {
    ...c,
    ok: x.searched > 0 && !short && x.hits.length === 0,
    detail:
      (x.searched === 0
        ? `searched nothing (${x.paths.join(", ")})`
        : x.hits.length
          ? `the bearer is in ${x.hits.join(", ")}`
          : short
            ? `searched ${x.searched} files, fewer than the ${x.known} this check read or found (${x.paths.join(", ")})`
            : `in none of ${x.searched} files under ${x.paths.join(", ")}; the launch env is a Den unit test`) +
      gaps,
  };
}

/** Clause 6: the helper gets the header from Den's server, and fails clearly without it. */
function header(r) {
  const c = { clause: clauses[5] };
  const g = r.agents;
  if (!r.line) return { ...c, ...NO_SERVER };
  if (g.error) return { ...c, ok: false, detail: g.error };
  const h = g.header ?? {};
  const rt = h.route;
  const den = !rt
    ? "needs-harness-fetch: Den's side was not asked"
    : rt.error
      ? `Den's bearers check: ${rt.error}`
      : `Den's bearers check: HTTP ${rt.status}, ${rt.listed ? (rt.served ? `serves ${SERVER}` : `can't serve ${SERVER}: ${rt.why}`) : `no ${SERVER}`}; a person at the agents' own route: HTTP ${h.self?.status}`;
  const denOk =
    !rt ||
    (!rt.error &&
      rt.status === 200 &&
      rt.served &&
      !rt.secretish &&
      h.self?.status === 403 &&
      !h.self.secretish);
  if (h.noSh)
    return denOk && rt
      ? {
          ...c,
          ok: null,
          skip: "needs-harness-agent-sh",
          detail: `${den}; the stub's handle has no sh, to run the helper in its session`,
        }
      : { ...c, ok: false, detail: den };
  if (h.noHelper)
    return {
      ...c,
      ok: false,
      detail: `A's MCP config has no ${SERVER} headers helper; ${den}`,
    };
  const up = h.up ?? {};
  const down = h.down ?? {};
  const words = (x) =>
    x.bad !== undefined
      ? `said "${x.bad}"`
      : `exit ${x.code}, ${x.header ? "a header" : "no header"}${x.says ? ", says Den isn't running" : ""}`;
  return {
    ...c,
    ok:
      denOk &&
      up.code === 0 &&
      up.header === true &&
      down.code !== 0 &&
      down.header === false &&
      down.says === true,
    detail: `in A's session, the helper: ${words(up)}; with Den out of reach: ${words(down)}; ${den}`,
  };
}

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
    inA(r0),
    {
      clause: clauses[3],
      ok: null,
      skip: "person",
      detail: "the add waits on the person's own Allow",
    },
    noBearer(r0),
    header(r0),
  ];
}
