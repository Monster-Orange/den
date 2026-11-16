/**
 * den#49: `<cli> hub put` / `<cli> hub pull` and the MCP tools hub_put /
 * hub_pull. An artifact's version as files, sent to Hub in parts through
 * Den's proxy (/hub/*), so a large mock lands whole as one version instead
 * of being typed into one call and cut off.
 *
 * A fake Hub in this process implements Hub's artifact routes (versions →
 * draft + missing; PUT drafts/:draft/files/:sha; commit; GET versions/:n and
 * files by sha). Den's side is the real proxy, with a fake agent principal.
 * Temp dirs only; invented names only.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import { createHash } from "crypto";
import * as fs from "fs";
import * as http from "http";
import type { AddressInfo } from "net";
import * as os from "os";
import * as path from "path";
import { cmdHub } from "../../../src/ui/cli/hub-command.js";
import { ownServer } from "../../../src/ui/cli/server-identity.js";
import { handleHubProxy } from "../../../src/ui/server/hub-proxy-routes.js";
import { setPrincipal } from "../../../src/ui/server/request-guard.js";
import {
  ACTION_TOOL_NAMES,
  callTool,
  type ToolContext,
} from "../../../src/ui/mcp/tools.js";
import type { DenApi } from "../../../src/ui/mcp/api.js";
import { toolsFor } from "../../../src/ui/mcp/tools.js";
import { HUB_PROMPT_LINE } from "../../../src/shared/hub.js";

const HUB_TOKEN = "hubi_TESTONLY_den49_install_token";
const AGENT_TOKEN = "den_at_TESTONLY0den49000agent0token000000000000";
const HUB_SITE = "https://hub.example.test";

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

const servers: http.Server[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise<void>((res) => s.close(() => res()));
  }
  for (const d of dirs.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});
function tmp(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(d);
  return d;
}

interface FakeFile {
  path: string;
  sha256: string;
  size: number;
  type: string;
  caption?: string;
}
interface FakeVersion {
  n: number;
  entry: string | null;
  note: string | null;
  files: FakeFile[];
}
interface Draft {
  slug: string;
  base: number;
  note: string | null;
  entry: string | null;
  files: FakeFile[];
  got: Set<string>;
}

/** A fake Hub: Hub's artifact pull/put routes, in memory. */
async function fakeHub() {
  const artifacts = new Map<
    string,
    { kind: string; versions: FakeVersion[] }
  >();
  const blobs = new Map<string, Buffer>();
  const drafts = new Map<string, Draft>();
  const seen: string[] = [];
  const headers: http.IncomingHttpHeaders[] = [];
  let commits = 0;
  let limits = {
    file_bytes: 25 * 1024 * 1024,
    bundle_bytes: 400 * 1024 * 1024,
    files: 5000,
  };
  /** Bytes served in place of a sha's (a tampered store). */
  const tampered = new Map<string, Buffer>();
  /** A listing served in place of a version's files. */
  let listing: FakeFile[] | null = null;
  /** How long each file PUT is held before its answer, and how many at once. */
  let putDelayMs = 0;
  let putsNow = 0;
  let putsMost = 0;

  const add = (
    slug: string,
    kind: string,
    files: { path: string; data: Buffer }[],
    entry: string | null,
  ) => {
    const a = artifacts.get(slug) ?? { kind, versions: [] };
    artifacts.set(slug, a);
    for (const f of files) blobs.set(sha(f.data), f.data);
    a.versions.push({
      n: a.versions.length + 1,
      entry,
      note: null,
      files: files.map((f) => ({
        path: f.path,
        sha256: sha(f.data),
        size: f.data.length,
        type: "application/octet-stream",
      })),
    });
  };

  const handle = (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    body: Buffer,
  ) => {
    const u = new URL(req.url ?? "/", "http://hub").pathname;
    seen.push(`${req.method} ${u}`);
    headers.push(req.headers);
    const json = (status: number, b: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(b));
    };
    if (req.headers.authorization !== `Bearer ${HUB_TOKEN}`)
      return json(401, { error: "a valid Hub token is required" });
    let m = /^\/api\/artifacts\/([^/]+)\/versions\/([^/]+)$/.exec(u);
    if (req.method === "GET" && m) {
      const a = artifacts.get(decodeURIComponent(m[1]));
      if (!a) return json(404, { error: "no such artifact here" });
      const n = m[2] === "latest" ? a.versions.length : Number(m[2]);
      const v = a.versions[n - 1];
      if (!v)
        return json(404, { error: `no version ${m[2]} of this artifact` });
      return json(200, {
        slug: m[1],
        kind: a.kind,
        n: v.n,
        entry: v.entry,
        note: v.note,
        files: listing ?? v.files,
        limits,
      });
    }
    m =
      /^\/api\/artifacts\/([^/]+)\/versions\/([^/]+)\/files\/([0-9a-f]{64})$/.exec(
        u,
      );
    if (req.method === "GET" && m) {
      const a = artifacts.get(decodeURIComponent(m[1]));
      const n = m[2] === "latest" ? (a?.versions.length ?? 0) : Number(m[2]);
      const v = a?.versions[n - 1];
      const files = listing ?? v?.files ?? [];
      if (!v || !files.some((f) => f.sha256 === m![3]))
        return json(404, { error: "that file isn't in this version" });
      const data = tampered.get(m[3]) ?? blobs.get(m[3]);
      if (!data) return json(404, { error: "that file isn't in the store" });
      res.writeHead(200, {
        "content-type": "application/octet-stream",
        "cache-control": "no-store",
      });
      return res.end(data);
    }
    m = /^\/api\/artifacts\/([^/]+)\/versions$/.exec(u);
    if (req.method === "POST" && m) {
      const slug = decodeURIComponent(m[1]);
      const a = artifacts.get(slug);
      if (!a) return json(404, { error: "no such artifact here" });
      const ask = JSON.parse(body.toString("utf8")) as {
        base: number;
        note?: string;
        entry?: string;
        files: FakeFile[];
      };
      // Hub's rules per kind (its checkFiles): a doc is one Markdown
      // file; an image one image file; a mock one page, or a bundle that
      // opens on its .html entry.
      const one = ask.files.length === 1 ? ask.files[0]!.path : "";
      if (a.kind === "doc" && !/\.(md|markdown|txt)$/i.test(one))
        return json(400, { error: "a doc is one Markdown file" });
      if (a.kind === "image" && !/\.(png|jpe?g|webp|gif|avif)$/i.test(one))
        return json(400, { error: "an image is one image file" });
      if (
        a.kind === "mock" &&
        !/\.html?$/i.test(one) &&
        !(
          ask.entry &&
          /\.html?$/i.test(ask.entry) &&
          ask.files.some((f) => f.path === ask.entry)
        )
      )
        return json(400, {
          error: "entry: the bundle's .html page it opens on",
        });
      const latest = a.versions.length;
      if (ask.base !== latest)
        return json(409, {
          error: `the artifact is at v${latest}, not v${ask.base}: pull it and try again`,
          latest,
        });
      const id = `drf_${drafts.size + 1}`;
      drafts.set(id, {
        slug,
        base: ask.base,
        note: ask.note ?? null,
        entry: ask.entry ?? null,
        files: ask.files,
        got: new Set(),
      });
      const missing = [...new Set(ask.files.map((f) => f.sha256))].filter(
        (h) => !blobs.has(h),
      );
      return json(201, {
        draft: id,
        missing,
        expires_at: "2026-11-16T00:00:00.000Z",
      });
    }
    m =
      /^\/api\/artifacts\/([^/]+)\/drafts\/([^/]+)\/files\/([0-9a-f]{64})$/.exec(
        u,
      );
    if (req.method === "PUT" && m) {
      const d = drafts.get(m[2]);
      const f = d?.files.find((x) => x.sha256 === m![3]);
      if (!d || !f)
        return json(404, { error: "the draft doesn't list that file" });
      if (body.length > limits.file_bytes)
        return json(413, { error: "the file is over the limit" });
      if (body.length !== f.size || sha(body) !== f.sha256)
        return json(422, {
          error: "the bytes don't match the listed sha256 and size",
        });
      blobs.set(f.sha256, body);
      d.got.add(f.sha256);
      res.writeHead(204);
      return res.end();
    }
    m = /^\/api\/artifacts\/([^/]+)\/drafts\/([^/]+)\/commit$/.exec(u);
    if (req.method === "POST" && m) {
      const d = drafts.get(m[2]);
      if (!d) return json(404, { error: "no such draft here" });
      const a = artifacts.get(d.slug)!;
      if (a.versions.length !== d.base)
        return json(409, {
          error: `the artifact moved to v${a.versions.length} since this draft (v${d.base}): pull it and try again`,
          latest: a.versions.length,
        });
      const missing = d.files.filter((f) => !blobs.has(f.sha256));
      if (missing.length)
        return json(409, {
          error: `${missing.length} files haven't been sent yet`,
          latest: a.versions.length,
        });
      commits++;
      const n = d.base + 1;
      a.versions.push({
        n,
        entry: d.entry,
        note: d.note,
        files: d.files.map((f) => ({
          ...f,
          type: "application/octet-stream",
        })),
      });
      drafts.delete(m[2]);
      return json(201, {
        n,
        pointer: `hub:${d.slug}@v${n}`,
        url: `${HUB_SITE}/acme/a/${d.slug}?v=${n}`,
      });
    }
    json(404, { error: "no such route" });
  };
  const s = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      if (putDelayMs && req.method === "PUT") {
        // A slow upload: count the file PUTs open at once, then answer.
        putsMost = Math.max(putsMost, ++putsNow);
        setTimeout(() => {
          putsNow--;
          handle(req, res, body);
        }, putDelayMs);
        return;
      }
      handle(req, res, body);
    });
  });
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${(s.address() as AddressInfo).port}`,
    artifacts,
    blobs,
    seen,
    headers,
    add,
    tampered,
    commits: () => commits,
    setLimits: (l: typeof limits) => (limits = l),
    setListing: (l: FakeFile[] | null) => (listing = l),
    setPutDelay: (ms: number) => (putDelayMs = ms),
    /** The most file PUTs Hub held open at once. */
    putsAtOnce: () => putsMost,
    /** The bytes Hub keeps for `slug`'s latest version, by path. */
    stored(slug: string): Map<string, Buffer> {
      const a = artifacts.get(slug)!;
      const v = a.versions[a.versions.length - 1];
      return new Map(v.files.map((f) => [f.path, blobs.get(f.sha256)!]));
    },
  };
}

/** Den's proxy in front of `hubUrl`, passing an agent's own Den token only. */
async function denProxy(hubUrl: string): Promise<string> {
  const s = http.createServer((req, res) => {
    if (req.headers.authorization === `Bearer ${AGENT_TOKEN}`)
      setPrincipal(req, {
        kind: "agent",
        actor: "agent:ada",
        workspace: "north",
        grants: [],
        session: { name: "north:ada", id: "s1" },
      });
    const p = new URL(req.url ?? "/", "http://localhost").pathname;
    // This Den says whose it is, as Den's own does (den#182).
    if (p === "/api/server-info") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(ownServer()));
      return;
    }
    void handleHubProxy(req, res, p, {
      upstream: async () => ({
        base: hubUrl,
        mcpUrl: `${hubUrl}/mcp`,
        headers: { Authorization: `Bearer ${HUB_TOKEN}`, "X-Den-Agent": "Ada" },
      }),
    }).then((handled) => {
      if (!handled) {
        res.writeHead(418);
        res.end("not the proxy's");
      }
    });
  });
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}

/** A 300 KB one-page mock (multi-byte text throughout) and a small image. */
function mockDir(): { dir: string; page: Buffer; logo: Buffer } {
  const dir = tmp("den49-mock-");
  const row = '<div class="row">Systems view: café — 日本語 — ✓ status</div>\n';
  let html =
    "<!doctype html>\n<html><head><meta charset=utf-8><title>Systems</title></head><body>\n";
  for (let i = 0; Buffer.byteLength(html) < 300 * 1024; i++)
    html += `<!-- ${i} -->${row}`;
  html += "<img src=logo.png></body></html>\n";
  const page = Buffer.from(html, "utf8");
  const logo = Buffer.from([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    ...Array.from({ length: 600 }, (_, i) => i % 256),
  ]);
  fs.writeFileSync(path.join(dir, "index.html"), page);
  fs.writeFileSync(path.join(dir, "logo.png"), logo);
  return { dir, page, logo };
}

/** Hub with mock "systems-view" at v1 (an older page, the same logo). */
async function setup() {
  const hub = await fakeHub();
  const m = mockDir();
  hub.add(
    "systems-view",
    "mock",
    [
      { path: "index.html", data: Buffer.from("<h1>old</h1>") },
      { path: "logo.png", data: m.logo },
    ],
    "index.html",
  );
  const base = await denProxy(hub.url);
  return { hub, m, base };
}

function cli(base: string) {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    run: (args: string[]) =>
      cmdHub(args, {
        env: { DEN_ACTOR_TOKEN: AGENT_TOKEN },
        denBase: () => base,
        out: (l) => out.push(l),
        err: (l) => err.push(l),
      }),
    all: () => [...out, ...err].join("\n"),
  };
}

function mcpCtx(base: string): ToolContext {
  const api: DenApi = {
    baseUrl: base,
    get: async () => ({}),
    stream: async () => ({ events: [], lines: [], ended: "done" }),
  };
  return {
    api,
    cfg: {
      actions: [...ACTION_TOOL_NAMES],
      runTestsEnvs: ["local"],
      logsRemote: false,
      approvals: true,
    },
    cli: "acme",
    env: { DEN_ACTOR_TOKEN: AGENT_TOKEN },
  } as ToolContext;
}

const noTokens = (text: string) => {
  expect(text).not.toContain(HUB_TOKEN);
  expect(text).not.toContain(AGENT_TOKEN);
};

describe("den#49: hub put, a large mock in parts", () => {
  it("CLI: a 300 KB page and its image land byte-identical as ONE version; only the missing file is sent", async () => {
    const { hub, m, base } = await setup();
    const c = cli(base);
    const code = await c.run([
      "put",
      m.dir,
      "hub:systems-view",
      "--note",
      "the systems view, whole",
    ]);
    expect([code, c.err]).toEqual([0, []]);
    expect(hub.commits()).toBe(1);
    const stored = hub.stored("systems-view");
    expect(sha(stored.get("index.html")!)).toBe(sha(m.page));
    expect(sha(stored.get("logo.png")!)).toBe(sha(m.logo));
    expect(stored.get("index.html")!.length).toBe(m.page.length);
    const v = hub.artifacts.get("systems-view")!.versions;
    expect(v).toHaveLength(2);
    expect(v[1]).toMatchObject({
      n: 2,
      entry: "index.html",
      note: "the systems view, whole",
    });
    // Hub had the logo: only the page went up, in one PUT.
    expect(hub.seen.filter((x) => x.startsWith("PUT "))).toEqual([
      `PUT /api/artifacts/systems-view/drafts/drf_1/files/${sha(m.page)}`,
    ]);
    expect(c.all()).toContain("hub:systems-view@v2");
    expect(c.all()).toContain(`${HUB_SITE}/acme/a/systems-view?v=2`);
    noTokens(c.all());
  });

  it("MCP hub_put: the same steps, the pointer back and never the file body", async () => {
    const { hub, m, base } = await setup();
    const r = await callTool(
      "hub_put",
      { path: m.dir, ref: "hub:systems-view", note: "from an agent" },
      mcpCtx(base),
    );
    expect(r.isError).toBe(false);
    expect(hub.commits()).toBe(1);
    const stored = hub.stored("systems-view");
    expect(sha(stored.get("index.html")!)).toBe(sha(m.page));
    expect(sha(stored.get("logo.png")!)).toBe(sha(m.logo));
    expect(r.text).toContain("hub:systems-view@v2");
    expect(r.text).toContain(`${HUB_SITE}/acme/a/systems-view?v=2`);
    expect(r.text).not.toContain("Systems view: café");
    expect(r.text.length).toBeLessThan(2000);
    noTokens(r.text);
  });

  it("a single .html file puts as the one-page mock (index.html)", async () => {
    const { hub, m, base } = await setup();
    const c = cli(base);
    const file = path.join(tmp("den49-file-"), "systems.html");
    fs.writeFileSync(file, m.page);
    expect(
      await c.run(["put", file, "hub:systems-view", "--note", "one page"]),
    ).toBe(0);
    const stored = hub.stored("systems-view");
    expect([...stored.keys()]).toEqual(["index.html"]);
    expect(sha(stored.get("index.html")!)).toBe(sha(m.page));
    expect(hub.commits()).toBe(1);
  });

  it("a moved base: Hub's 409 says so and names the latest version; nothing is committed", async () => {
    const { hub, m, base } = await setup();
    hub.add(
      "systems-view",
      "mock",
      [{ path: "index.html", data: Buffer.from("<h1>v2</h1>") }],
      "index.html",
    );
    hub.add(
      "systems-view",
      "mock",
      [{ path: "index.html", data: Buffer.from("<h1>v3</h1>") }],
      "index.html",
    );
    const c = cli(base);
    expect(
      await c.run([
        "put",
        m.dir,
        "hub:systems-view",
        "--note",
        "late",
        "--base",
        "1",
      ]),
    ).toBe(1);
    expect(c.err.join("\n")).toMatch(/moved/i);
    expect(c.err.join("\n")).toContain("v3");
    expect(c.err.join("\n")).toContain("hub:systems-view@v3");
    expect(hub.commits()).toBe(0);
    noTokens(c.all());
    const r = await callTool(
      "hub_put",
      { path: m.dir, ref: "hub:systems-view", base: 1 },
      mcpCtx(base),
    );
    expect(r.isError).toBe(true);
    expect(r.text).toContain("hub:systems-view@v3");
    expect(hub.commits()).toBe(0);
  });

  it("Hub's limits are checked first: a file over them is refused before any draft", async () => {
    const { hub, m, base } = await setup();
    hub.setLimits({
      file_bytes: 100 * 1024,
      bundle_bytes: 400 * 1024 * 1024,
      files: 5000,
    });
    const c = cli(base);
    expect(await c.run(["put", m.dir, "hub:systems-view", "--note", "x"])).toBe(
      1,
    );
    expect(c.err.join("\n")).toMatch(/index\.html.*over/);
    expect(
      hub.seen.filter((x) => x.startsWith("POST ") || x.startsWith("PUT ")),
    ).toEqual([]);
  });

  it("outside an agent: refused, and Hub hears nothing", async () => {
    const { hub, m, base } = await setup();
    const err: string[] = [];
    const code = await cmdHub(["put", m.dir, "hub:systems-view"], {
      env: {},
      denBase: () => base,
      out: () => undefined,
      err: (l) => err.push(l),
    });
    expect(code).toBe(2);
    expect(err.join("\n")).toMatch(/runs inside an agent Den started/);
    expect(hub.seen).toEqual([]);
  });
});

describe("den#49: hub pull, checked", () => {
  async function pulled() {
    const { hub, m, base } = await setup();
    const c = cli(base);
    expect(
      await c.run(["put", m.dir, "hub:systems-view", "--note", "v2"]),
    ).toBe(0);
    return { hub, m, base };
  }

  it("CLI and MCP: writes byte-identical files", async () => {
    const { m, base } = await pulled();
    const c = cli(base);
    const into = path.join(tmp("den49-pull-"), "out");
    expect(await c.run(["pull", "hub:systems-view@v2", into])).toBe(0);
    expect(sha(fs.readFileSync(path.join(into, "index.html")))).toBe(
      sha(m.page),
    );
    expect(sha(fs.readFileSync(path.join(into, "logo.png")))).toBe(sha(m.logo));
    expect(c.all()).toContain("hub:systems-view@v2");
    noTokens(c.all());
    const into2 = path.join(tmp("den49-pull-"), "out");
    const r = await callTool(
      "hub_pull",
      { ref: "hub:systems-view@latest", dir: into2 },
      mcpCtx(base),
    );
    expect(r.isError).toBe(false);
    expect(r.text).toContain("hub:systems-view@v2");
    expect(r.text).not.toContain("Systems view: café");
    expect(sha(fs.readFileSync(path.join(into2, "index.html")))).toBe(
      sha(m.page),
    );
    noTokens(r.text);
  });

  it("a tampered file is refused and not written", async () => {
    const { hub, m, base } = await pulled();
    hub.tampered.set(sha(m.page), Buffer.from("<h1>not the page</h1>"));
    const c = cli(base);
    const into = path.join(tmp("den49-pull-"), "out");
    expect(await c.run(["pull", "hub:systems-view@latest", into])).toBe(1);
    expect(c.err.join("\n")).toMatch(/index\.html.*sha256/);
    expect(fs.existsSync(path.join(into, "index.html"))).toBe(false);
    const r = await callTool(
      "hub_pull",
      { ref: "hub:systems-view", dir: path.join(tmp("den49-pull-"), "o") },
      mcpCtx(base),
    );
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/sha256/);
  });

  it('a path with ".." or an absolute one is refused, and nothing is written', async () => {
    const { hub, m, base } = await pulled();
    const root = tmp("den49-pull-");
    const into = path.join(root, "out");
    for (const bad of ["../x", "/tmp/den49-x", "a/../../x"]) {
      hub.setListing([
        {
          path: bad,
          sha256: sha(m.logo),
          size: m.logo.length,
          type: "image/png",
        },
      ]);
      const c = cli(base);
      expect(await c.run(["pull", "hub:systems-view@v2", into])).toBe(1);
      expect(c.err.join("\n")).toMatch(/path/);
    }
    expect(fs.existsSync(path.join(root, "x"))).toBe(false);
    expect(fs.existsSync("/tmp/den49-x")).toBe(false);
    expect(fs.existsSync(into) ? fs.readdirSync(into) : []).toEqual([]);
  });
});

describe("den#49: captions, kinds, and four at a time", () => {
  /** A small PNG-looking file, different per `seed`. */
  const png = (seed: number) =>
    Buffer.from([
      0x89,
      0x50,
      0x4e,
      0x47,
      0x0d,
      0x0a,
      0x1a,
      0x0a,
      ...Array.from({ length: 300 }, (_, i) => (i * seed) % 256),
    ]);

  it("captions: read from captions.json on put (never sent as a file), written back to captions.json on pull", async () => {
    const hub = await fakeHub();
    hub.add("brand-logo", "image", [{ path: "logo.png", data: png(3) }], null);
    const base = await denProxy(hub.url);
    const dir = tmp("den49-cap-");
    const logo = png(7);
    fs.writeFileSync(path.join(dir, "logo.png"), logo);
    fs.writeFileSync(
      path.join(dir, "captions.json"),
      JSON.stringify({ "logo.png": "The logo, on a dark ground" }),
    );
    const c = cli(base);
    expect(
      await c.run(["put", dir, "hub:brand-logo", "--note", "darker"]),
    ).toBe(0);
    const v = hub.artifacts.get("brand-logo")!.versions;
    expect(v).toHaveLength(2);
    // One file, its caption with it; captions.json itself is not a file.
    expect(v[1]!.files.map((f) => [f.path, f.caption])).toEqual([
      ["logo.png", "The logo, on a dark ground"],
    ]);
    expect(hub.seen.filter((x) => x.startsWith("PUT "))).toEqual([
      `PUT /api/artifacts/brand-logo/drafts/drf_1/files/${sha(logo)}`,
    ]);
    // Pull, through the CLI and through hub_pull: the file, and its
    // caption in captions.json.
    for (const how of ["cli", "mcp"]) {
      const into = path.join(tmp("den49-cap-pull-"), "out");
      if (how === "cli")
        expect(await cli(base).run(["pull", "hub:brand-logo", into])).toBe(0);
      else
        expect(
          (
            await callTool(
              "hub_pull",
              { ref: "hub:brand-logo@v2", dir: into },
              mcpCtx(base),
            )
          ).isError,
        ).toBe(false);
      expect(sha(fs.readFileSync(path.join(into, "logo.png")))).toBe(sha(logo));
      expect(
        JSON.parse(fs.readFileSync(path.join(into, "captions.json"), "utf8")),
      ).toEqual({ "logo.png": "The logo, on a dark ground" });
      expect(fs.readdirSync(into).sort()).toEqual([
        "captions.json",
        "logo.png",
      ]);
    }
  });

  it("captions: one for a file that isn't there is refused before Hub hears of the put", async () => {
    const hub = await fakeHub();
    hub.add("brand-logo", "image", [{ path: "logo.png", data: png(3) }], null);
    const base = await denProxy(hub.url);
    const dir = tmp("den49-cap-");
    fs.writeFileSync(path.join(dir, "logo.png"), png(7));
    fs.writeFileSync(
      path.join(dir, "captions.json"),
      JSON.stringify({ "logo.svg": "not here" }),
    );
    const c = cli(base);
    expect(await c.run(["put", dir, "hub:brand-logo"])).toBe(1);
    expect(c.err.join("\n")).toMatch(/captions\.json.*logo\.svg/);
    expect(hub.seen).toEqual([]);
  });

  it("kinds: a mock, an image and a doc each put as one version and pull back byte-identical, with their kind", async () => {
    const hub = await fakeHub();
    const m = mockDir();
    hub.add(
      "systems-view",
      "mock",
      [{ path: "index.html", data: Buffer.from("<h1>old</h1>") }],
      "index.html",
    );
    hub.add("brand-logo", "image", [{ path: "logo.png", data: png(3) }], null);
    hub.add(
      "release-notes",
      "doc",
      [{ path: "index.md", data: Buffer.from("# Notes\n") }],
      null,
    );
    const base = await denProxy(hub.url);
    const imgDir = tmp("den49-img-");
    const img = png(11);
    fs.writeFileSync(path.join(imgDir, "logo.png"), img);
    const docFile = path.join(tmp("den49-doc-"), "index.md");
    const doc = Buffer.from(
      "# Notes\n\nCafé, 日本語, and a list:\n\n- one\n",
      "utf8",
    );
    fs.writeFileSync(docFile, doc);
    const cases = [
      {
        slug: "systems-view",
        kind: "mock",
        src: m.dir,
        files: { "index.html": m.page, "logo.png": m.logo },
      },
      {
        slug: "brand-logo",
        kind: "image",
        src: path.join(imgDir, "logo.png"),
        files: { "logo.png": img },
      },
      {
        slug: "release-notes",
        kind: "doc",
        src: docFile,
        files: { "index.md": doc },
      },
    ];
    for (const k of cases) {
      const c = cli(base);
      expect([
        await c.run(["put", k.src, `hub:${k.slug}`, "--note", k.kind]),
        c.err,
      ]).toEqual([0, []]);
      expect(c.all()).toContain(`hub:${k.slug}@v2`);
      const into = path.join(tmp("den49-kind-"), "out");
      const p = cli(base);
      expect(await p.run(["pull", `hub:${k.slug}@v2`, into, "--json"])).toBe(0);
      const r = JSON.parse(p.out.join("\n")) as { kind: string; n: number };
      expect([r.kind, r.n]).toEqual([k.kind, 2]);
      for (const [f, data] of Object.entries(k.files))
        expect(sha(fs.readFileSync(path.join(into, f)))).toBe(sha(data));
      expect(fs.readdirSync(into).sort()).toEqual(Object.keys(k.files).sort());
    }
    expect(hub.commits()).toBe(3);
  });

  it("kinds: a mock of several files with no page to open on is refused before any draft", async () => {
    const hub = await fakeHub();
    hub.add(
      "systems-view",
      "mock",
      [{ path: "index.html", data: Buffer.from("<h1>old</h1>") }],
      "index.html",
    );
    const base = await denProxy(hub.url);
    const dir = tmp("den49-nopage-");
    fs.writeFileSync(path.join(dir, "a.html"), "<h1>a</h1>");
    fs.writeFileSync(path.join(dir, "b.html"), "<h1>b</h1>");
    const c = cli(base);
    expect(await c.run(["put", dir, "hub:systems-view"])).toBe(1);
    expect(c.err.join("\n")).toMatch(/--entry/);
    expect(hub.seen.filter((x) => !x.startsWith("GET "))).toEqual([]);
    // With --entry, it goes.
    expect(
      await cli(base).run([
        "put",
        dir,
        "hub:systems-view",
        "--entry",
        "b.html",
      ]),
    ).toBe(0);
    expect(hub.artifacts.get("systems-view")!.versions[1]!.entry).toBe(
      "b.html",
    );
  });

  it("the missing files go up four at a time, never more, and every one arrives", async () => {
    const hub = await fakeHub();
    hub.add(
      "systems-view",
      "mock",
      [{ path: "index.html", data: Buffer.from("<h1>old</h1>") }],
      "index.html",
    );
    hub.setPutDelay(150);
    const base = await denProxy(hub.url);
    const dir = tmp("den49-many-");
    fs.writeFileSync(path.join(dir, "index.html"), "<h1>many</h1>");
    const sent: string[] = [];
    for (let i = 0; i < 11; i++) {
      const b = png(i + 20);
      fs.writeFileSync(path.join(dir, `p${i}.png`), b);
      sent.push(sha(b));
    }
    const c = cli(base);
    expect([await c.run(["put", dir, "hub:systems-view"]), c.err]).toEqual([
      0,
      [],
    ]);
    const puts = hub.seen.filter((x) => x.startsWith("PUT "));
    expect(puts).toHaveLength(12);
    for (const h of sent) expect(puts.some((x) => x.endsWith(h))).toBe(true);
    expect(hub.putsAtOnce()).toBe(4);
    expect(hub.commits()).toBe(1);
  });
});

describe("den#49: agents are told, and have the tools", () => {
  it("hub_put and hub_pull are registered without any mcp.actions", () => {
    const names = toolsFor({
      actions: [],
      runTestsEnvs: ["local"],
      logsRemote: false,
      approvals: false,
    }).map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["hub_put", "hub_pull"]));
  });

  it("every agent's Hub line says to publish files with hub_put, never by pasting a page into one call", () => {
    expect(HUB_PROMPT_LINE).toContain("hub_put");
    expect(HUB_PROMPT_LINE).toContain("hub_pull");
    expect(HUB_PROMPT_LINE).toMatch(
      /never by pasting a page's text into one call/,
    );
  });
});
