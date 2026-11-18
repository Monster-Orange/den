/**
 * Issue 521: the shapes of the requests Den makes to Hub, for Hub's
 * contract suite (docs/hub-contract/README.md).
 *
 * Each request is built by Den's real call (hubExchange, hubRevoke,
 * fetchHubTools, hubPutProjects, hubAckDelivery) with placeholder inputs
 * and a fetch that records the request instead of sending it. So the
 * fixture is what the code sends; scripts/hub-contract-export.mjs writes
 * it and tests/unit/shared/hub-contract.test.ts fails when the code and
 * the folder for the current version disagree.
 *
 * Sentinels stand in for every value: they pass Den's own checks (a repo
 * slug, a Hub project id) and are then swapped for the placeholders
 * <token> <uuid> <team> <project> <iso8601> <sha> <host>, and :id in a
 * path. No data, token, or name of a real org, app or host is written.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import {
  hubAckDelivery,
  hubExchange,
  hubPutProjects,
  hubRevoke,
} from "./hub.js";
import { ackBody } from "./hub-delivery.js";
import {
  projectList,
  projectSyncBody,
  syncAgents,
} from "./hub-project-sync.js";
import { fetchHubTools } from "./hub-tools.js";
import { DEN_PROTOCOL, denCapabilities, denVersion } from "./hub-compat.js";
import type { WorkspacesFile } from "./types/index.js";

/** The calls the contract holds, as Den and Hub agreed them (Den makes these). */
export const HUB_CONTRACT_CALLS = [
  "connect-token",
  "connect-revoke",
  "mcp-initialize",
  "mcp-tools-list",
  "install-projects",
  "delivery-ack",
] as const;

/**
 * Agreed names Den doesn't make itself: agents make these tools/call
 * requests through Den's proxy, which sets only the headers.
 */
export const HUB_CONTRACT_NOT_MADE = [
  "mcp-hub_whoami",
  "mcp-hub_search",
  "mcp-hub_artifact_create",
  "mcp-hub_ask",
] as const;

export const HUB_CONTRACT_GENERATOR = "scripts/hub-contract-export.mjs";
/** How many den-<version> folders the export keeps. */
export const HUB_CONTRACT_KEEP = 3;

export type HubContractCall = (typeof HUB_CONTRACT_CALLS)[number];

export interface RequestFixture {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
  body_schema?: Record<string, unknown>;
}

export interface ContractManifest {
  den_version: string;
  protocol: number;
  capabilities: string[];
  exported_at: string;
  generator: string;
}

export interface HubContract {
  manifest: ContractManifest;
  requests: Record<string, RequestFixture>;
}

const HOST = "host0placeholder0.invalid";
const TOKEN = "tok0placeholder0";
const UUID = "00000000-0000-4000-8000-00000000c0de";
const SESSION = "sess0placeholder0";
const DELIVERY = "dlv0placeholder0";
const TEAM = "team0placeholder0";
const PROJECT = "project0placeholder0";
const ISO = "2000-01-01T00:00:00.000Z";

/** Sentinel → placeholder, longest first. */
const SWAPS: [string, string][] = [
  [HOST, "<host>"],
  [TOKEN, "<token>"],
  [UUID, "<uuid>"],
  [SESSION, "<uuid>"],
  [TEAM, "<team>"],
  [PROJECT, "<project>"],
  [ISO, "<iso8601>"],
];

const swap = (s: string) =>
  SWAPS.reduce((acc, [from, to]) => acc.split(from).join(to), s);

interface Recorded {
  url: string;
  init: RequestInit;
}

/** A fetch that records each request and answers as Hub would, minimally. */
function recorder(): { fetch: typeof fetch; seen: Recorded[] } {
  const seen: Recorded[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    seen.push({ url, init: init ?? {} });
    const json = (v: unknown, headers: Record<string, string> = {}) =>
      new Response(JSON.stringify(v), {
        status: 200,
        headers: { "content-type": "application/json", ...headers },
      });
    if (new URL(url).pathname === "/mcp") {
      const m = init?.body
        ? (JSON.parse(String(init.body)) as { id?: number })
        : {};
      return json(
        {
          jsonrpc: "2.0",
          id: m.id,
          result: { protocolVersion: "2025-06-18", tools: [] },
        },
        { "mcp-session-id": SESSION },
      );
    }
    if (url.endsWith("/connect/token")) return json({ token: TOKEN });
    return json({});
  }) as typeof fetch;
  return { fetch: f, seen };
}

function headerRecord(h: RequestInit["headers"]): Record<string, string> {
  const out: Record<string, string> = {};
  const src =
    h instanceof Headers
      ? Object.fromEntries(h.entries())
      : Array.isArray(h)
        ? Object.fromEntries(h)
        : ((h ?? {}) as Record<string, string>);
  for (const k of Object.keys(src).sort()) out[k] = swap(String(src[k]));
  return out;
}

/** One recorded request as its fixture: placeholders only. */
function fixture(r: Recorded): RequestFixture {
  const u = new URL(r.url);
  const p = decodeURIComponent(u.pathname).split(DELIVERY).join(":id");
  const body =
    r.init.body === undefined || r.init.body === null
      ? null
      : (JSON.parse(swap(String(r.init.body))) as unknown);
  return {
    method: (r.init.method ?? "GET").toUpperCase(),
    path: swap(`${p}${u.search}`),
    headers: headerRecord(r.init.headers),
    body,
  };
}

/** Den's project map for one placeholder project with one agent. */
function placeholderProjects() {
  const file = {
    workspaces: {
      [PROJECT]: { hub_project: { id: UUID, slug: PROJECT, name: PROJECT } },
    },
  } as unknown as WorkspacesFile;
  const agents = syncAgents([
    { id: UUID, workspace: PROJECT, displayName: PROJECT },
  ]);
  return projectList(
    file,
    () => [`${TEAM}/${PROJECT}`],
    (ws) => agents.get(ws) ?? [],
  );
}

/** Every request in the contract, built by Den's real calls. */
export async function buildHubContract(
  now: () => Date = () => new Date(),
): Promise<HubContract> {
  const url = `https://${HOST}`;
  const requests: Record<string, RequestFixture> = {};
  const one = async (
    name: HubContractCall,
    run: (f: typeof fetch) => Promise<unknown>,
  ) => {
    const r = recorder();
    await run(r.fetch);
    if (r.seen.length !== 1)
      throw new Error(`${name}: ${r.seen.length} requests, not one`);
    requests[name] = fixture(r.seen[0]);
  };
  await one("connect-token", (f) =>
    hubExchange(
      url,
      { code: TOKEN, redirectUri: `${url}/hub/callback`, verifier: TOKEN },
      { fetch: f },
    ),
  );
  await one("connect-revoke", (f) => hubRevoke(url, TOKEN, { fetch: f }));
  {
    const r = recorder();
    await fetchHubTools(`${url}/mcp`, TOKEN, { fetch: r.fetch });
    const by = (m: string) =>
      r.seen.find(
        (s) =>
          (JSON.parse(String(s.init.body)) as { method?: string }).method === m,
      );
    const init = by("initialize");
    const list = by("tools/list");
    if (!init || !list)
      throw new Error("mcp: initialize or tools/list missing");
    requests["mcp-initialize"] = fixture(init);
    requests["mcp-tools-list"] = fixture(list);
  }
  await one("install-projects", (f) =>
    hubPutProjects(url, TOKEN, projectSyncBody(placeholderProjects(), ISO), {
      fetch: f,
    }),
  );
  await one("delivery-ack", (f) =>
    hubAckDelivery(url, TOKEN, DELIVERY, ackBody("done", { version: 1 }), {
      fetch: f,
    }),
  );
  const ordered: Record<string, RequestFixture> = {};
  for (const c of HUB_CONTRACT_CALLS) ordered[c] = requests[c];
  return {
    manifest: {
      den_version: denVersion(),
      protocol: DEN_PROTOCOL,
      capabilities: denCapabilities().split(","),
      exported_at: now().toISOString(),
      generator: HUB_CONTRACT_GENERATOR,
    },
    requests: ordered,
  };
}

/** A folder as the export wrote it: its manifest and requests. */
export function readContractFolder(dir: string): {
  manifest: Record<string, unknown> | null;
  requests: Record<string, unknown>;
} {
  const requests: Record<string, unknown> = {};
  let manifest: Record<string, unknown> | null = null;
  for (const f of fs.readdirSync(dir).sort()) {
    const text = fs.readFileSync(path.join(dir, f), "utf-8");
    if (f === "manifest.json")
      manifest = JSON.parse(text) as Record<string, unknown>;
    else if (f.endsWith(".request.json"))
      requests[f.slice(0, -".request.json".length)] = JSON.parse(
        text,
      ) as unknown;
  }
  return { manifest, requests };
}

/** A semver, pre-release and build parts allowed. */
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * The folder for Den version `v`: den-<major.minor.patch>, with any
 * pre-release or build part dropped (0.4.71-dev.3 → den-0.4.71), so a
 * dev bump compares against the same folder.
 */
export function contractFolderName(v: string): string {
  return `den-${v.split("+")[0].split("-")[0]}`;
}

/** JSON with object keys sorted, for an order-free compare. */
function canon(v: unknown): string {
  return JSON.stringify(v, (_k, x: unknown) =>
    x && typeof x === "object" && !Array.isArray(x)
      ? Object.fromEntries(
          Object.keys(x as object)
            .sort()
            .map((k) => [k, (x as Record<string, unknown>)[k]]),
        )
      : x,
  );
}

/**
 * How a folder's headers differ from the code's, or null: by name, and by
 * value except X-Den-Version, which is checked by format only.
 */
function headerProblem(f: unknown, b: Record<string, string>): string | null {
  if (!f || typeof f !== "object" || Array.isArray(f)) return "not an object";
  const fh = f as Record<string, unknown>;
  const names = Object.keys(fh).sort();
  if (canon(names) !== canon(Object.keys(b).sort()))
    return "header names differ from the code";
  for (const n of names) {
    if (n.toLowerCase() === "x-den-version") {
      if (typeof fh[n] !== "string" || !SEMVER.test(fh[n] as string))
        return "X-Den-Version is not a version";
    } else if (fh[n] !== b[n]) return `${n} differs from the code`;
  }
  return null;
}

/**
 * Where the code and a folder disagree, one line each; empty when they
 * match. Shapes only: the exact Den version (X-Den-Version, the
 * manifest's den_version) is checked by format, never by value, so a
 * folder exported at one dev version holds for the next (the caller picks
 * the folder: contractFolderName), and exported_at not at all.
 */
export function contractDrift(
  built: HubContract,
  folder: ReturnType<typeof readContractFolder>,
): string[] {
  const out: string[] = [];
  if (!folder.manifest) out.push("manifest.json: missing");
  else {
    const dv = folder.manifest.den_version;
    if (typeof dv !== "string" || !SEMVER.test(dv))
      out.push(`manifest.json: den_version is ${canon(dv)}, not a version`);
    for (const k of ["protocol", "capabilities", "generator"] as const)
      if (canon(folder.manifest[k]) !== canon(built.manifest[k]))
        out.push(
          `manifest.json: ${k} is ${canon(folder.manifest[k])}, the code says ${canon(built.manifest[k])}`,
        );
  }
  const names = new Set([
    ...Object.keys(built.requests),
    ...Object.keys(folder.requests),
  ]);
  for (const n of [...names].sort()) {
    const b = built.requests[n];
    const f = folder.requests[n];
    if (!f)
      out.push(`${n}: the code makes it, the folder has no ${n}.request.json`);
    else if (!b) out.push(`${n}: in the folder, the code doesn't make it`);
    else
      for (const k of [
        "method",
        "path",
        "headers",
        "body",
        "body_schema",
      ] as const) {
        const fv = (f as Record<string, unknown>)[k];
        const bv = (b as unknown as Record<string, unknown>)[k];
        if (k === "headers") {
          const why = headerProblem(fv, bv as Record<string, string>);
          if (why) out.push(`${n}: headers: ${why}`);
        } else if (canon(fv) !== canon(bv))
          out.push(`${n}: ${k} differs from the code`);
      }
  }
  return out;
}

/** Semver order (prereleases before their release), oldest first. */
export function compareSemver(a: string, b: string): number {
  const parse = (v: string) => {
    const [core, pre] = v.split("+")[0].split(/-(.*)/s);
    return {
      nums: core.split(".").map((n) => Number(n) || 0),
      pre: pre ? pre.split(".") : [],
    };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++)
    if ((x.nums[i] ?? 0) !== (y.nums[i] ?? 0))
      return (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
  if (!x.pre.length || !y.pre.length) return y.pre.length - x.pre.length;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn && Number(p) !== Number(q)) return Number(p) - Number(q);
    if (pn !== qn) return pn ? -1 : 1;
    if (p !== q) return p < q ? -1 : 1;
  }
  return 0;
}

const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;

/**
 * Write `c` to <root>/den-<release>/ (contractFolderName; its old files
 * replaced, its den_version the exact one), then keep
 * only the newest HUB_CONTRACT_KEEP den-* folders. The folders it removed.
 */
export function writeHubContract(root: string, c: HubContract): string[] {
  const dir = path.join(root, contractFolderName(c.manifest.den_version));
  fs.mkdirSync(dir, { recursive: true });
  for (const f of fs.readdirSync(dir))
    if (f.endsWith(".json")) fs.rmSync(path.join(dir, f));
  fs.writeFileSync(path.join(dir, "manifest.json"), json(c.manifest));
  for (const [name, r] of Object.entries(c.requests))
    fs.writeFileSync(path.join(dir, `${name}.request.json`), json(r));
  const dens = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name.startsWith("den-"))
    .map((d) => d.name)
    .sort((a, b) => compareSemver(a.slice(4), b.slice(4)));
  const gone = dens.slice(0, Math.max(0, dens.length - HUB_CONTRACT_KEEP));
  for (const d of gone)
    fs.rmSync(path.join(root, d), { recursive: true, force: true });
  return gone;
}
