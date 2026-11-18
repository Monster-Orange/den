/* eslint-env browser */
// Live check for #335: a project's extra HTTP MCP servers are listed in Settings › Project and in doctor,
// by name and url only; an agent in the server's project gets it and an agent in another project doesn't;
// and the bearer is in no file or log. Adding one is a held write that waits on the person's Allow, so the
// check uses the bed's own server (SERVER, bearer ref REF, in the bed's default project) and never adds one.
//
// Setup starts two stub agents under this check's own names (gate335-*): one in the server's project, one
// in OTHER. It reads each one's MCP config, has the first fetch its headers (`<cli> mcp headers SERVER`,
// inside its own session), and has the harness search the agents' files, sessions and Den's logs for the
// bearer. The harness holds the test value: the check never sees, prints or writes it, and never reads a
// process's environment. Teardown removes both stubs.
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

const SERVER = "gate-mcp";
const SERVER_URL = "http://127.0.0.1:7898/mcp";
const REF = "gate_mcp";
const OTHER = "proj-gate";

/** The doctor line for SERVER: its project, and whether its bearer ref is set. */
function serverLine(lines) {
  const l = lines.find((x) =>
    new RegExp(`^mcp server\\s+\\S+\\s+[\\w.-]+: ${SERVER} `).test(x),
  );
  if (!l) return null;
  return {
    project: /^mcp server\s+\S+\s+([\w.-]+):/.exec(l)[1],
    refSet: !l.includes(`secrets.refs.${REF} is not set`),
  };
}

/** A stub under this check's name, started (in `workspace` when given) and running; recorded for teardown. */
async function stub(ctx, state, role, workspace) {
  const name = `gate335-${role}-${state.tag}`;
  const ctl = workspace
    ? await ctx.agent(name, { workspace })
    : await ctx.agent(name);
  const a = { name, id: ctl?.id ?? name, ctl };
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
  const rec = await ctx.readBed(`agents/${a.id}.json`);
  const cfg = await ctx.readBed(`agent-files/${a.id}/mcp.json`);
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

/** Clauses 3 and 5, both through the two stubs. Never throws: an error is the clause's own answer. */
async function agents(ctx, state, line) {
  const out = { a: null, b: null, error: null, headers: null, seen: null };
  if (typeof ctx.secretSeen !== "function") out.noSecretSeen = true;
  try {
    const a = await stub(ctx, state, "a");
    if (typeof a.ctl.sh !== "function") out.noSh = true;
    const b = await stub(ctx, state, "b", OTHER);
    out.a = await seenBy(ctx, a);
    out.b = await seenBy(ctx, b);
    if (!out.noSh && line.refSet) {
      // Inside A's own session (its token); the harness redacts the value.
      const r = await a.ctl.sh(`den-gate mcp headers ${SERVER}`);
      out.headers = {
        status: r?.status ?? null,
        header: /"Authorization"\s*:\s*"Bearer \S/.test(String(r?.out ?? "")),
        err: String(r?.err ?? "").slice(0, 200),
      };
    }
    for (const x of [a, b]) await x.ctl.stop();
    if (!out.noSecretSeen && line.refSet) {
      const paths = [
        ...state.made.flatMap((x) => [
          `agent-files/${x.id}`,
          `agents/${x.id}.json`,
        ]),
        "sessions",
        "logs",
      ];
      const seen = await ctx.secretSeen(REF, paths);
      out.seen = (Array.isArray(seen) ? seen : []).map((x) => ({
        path: String(x?.path ?? ""),
        hit: x?.hit === true,
      }));
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
  if (line) state.agents = await agents(ctx, state, line);
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
  // The harness started B somewhere other than OTHER: it has no project option yet.
  if (g.b.workspace !== OTHER)
    return {
      clause: clauses[2],
      ok: null,
      skip: "needs-harness-agent-workspace",
      detail: `ctx.agent(id, { workspace: "${OTHER}" }) started the agent in ${g.b.workspace ?? "no project"}`,
    };
  const a = g.a.server;
  return {
    clause: clauses[2],
    ok:
      g.a.workspace === r.line.project &&
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
  if (!r.line.refSet)
    return {
      ...c,
      ok: null,
      skip: "needs-test-bearer",
      detail: `secrets.refs.${REF} is not set on the bed`,
    };
  if (g.error) return { ...c, ok: false, detail: g.error };
  if (g.noSh)
    return {
      ...c,
      ok: null,
      skip: "needs-harness-sh",
      detail:
        "the stub's handle has no sh(cmd), to fetch the headers inside its session",
    };
  if (g.noSecretSeen)
    return {
      ...c,
      ok: null,
      skip: "needs-harness-secretSeen",
      detail:
        "ctx has no secretSeen(ref, paths), to search files for the bearer without reading it",
    };
  const h = g.headers;
  const hits = g.seen.filter((x) => x.hit).map((x) => x.path);
  return {
    ...c,
    ok: h.status === 0 && h.header && g.seen.length > 0 && hits.length === 0,
    detail:
      `headers: ${h.status === 0 && h.header ? "the Authorization header came back" : `no Authorization header (status ${h.status}${h.err ? `: ${h.err}` : ""})`}; ` +
      (g.seen.length === 0
        ? "searched nothing"
        : hits.length
          ? `the bearer is in ${hits.join(", ")}`
          : `in none of ${g.seen.length} paths (${g.seen.map((x) => x.path).join(", ")})`),
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
  ];
}
