/**
 * den#49: an artifact's version as files, to and from Hub, in parts.
 *
 * One module for `<cli> hub put` / `<cli> hub pull` and the MCP tools
 * hub_put / hub_pull: the same steps, the same checks. Every call goes
 * through Den's proxy to Hub (`<Den>/hub/...`, hub-proxy-routes.ts) with
 * the agent's own Den token; Den attaches the install's Hub token. Nothing
 * here reads, holds or prints a Hub token.
 *
 * Hub's routes (its artifact pull/put API):
 *   GET  /api/artifacts/:slug/versions/:n|latest
 *        → { slug, kind, n, entry, note, files: [{path, sha256, size, type,
 *            caption?}], limits: { file_bytes, bundle_bytes, files } }
 *   GET  /api/artifacts/:slug/versions/:n/files/:sha256 → the bytes
 *   POST /api/artifacts/:slug/versions { base, note, entry, files }
 *        → 201 { draft, missing: [sha256], expires_at }; 409 { error, latest }
 *          when base isn't the latest
 *   PUT  /api/artifacts/:slug/drafts/:draft/files/:sha256 → 204 (422 when
 *        the bytes don't match, 413 over a limit)
 *   POST /api/artifacts/:slug/drafts/:draft/commit → 201 { n, pointer, url };
 *        409 { error, latest } when the artifact moved or a file is missing
 *
 * Put: Hub's limits are checked first (from the latest version), then a
 * draft lists every file; only the files Hub lacks are sent, four at a time;
 * commit makes ONE new version. Pull: every path is checked before anything
 * is written (relative, no "..", no absolute path), and every file's sha256
 * and size are checked before it is written.
 */
import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { product } from "./product.js";

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/** How these calls reach Hub: Den's base URL and the agent's own Den token. */
export interface HubVia {
  /** Den's web address as the agent reaches it (no /hub). */
  denBase: string;
  /** The agent's own Den token (never a Hub token). */
  token: string;
  fetch?: Fetch;
  /** Files sent or fetched at once (4). */
  parallel?: number;
}

/** A refusal or failure, in words for the agent or person. */
export class HubFilesError extends Error {
  constructor(
    message: string,
    /** Hub's latest version, when the put's base moved. */
    readonly latest?: number,
  ) {
    super(message);
  }
}

const SHA = /^[0-9a-f]{64}$/;
const SLUG = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,199}$/;
/** The captions file in a put's folder: { "<path>": "<caption>" }. */
export const CAPTIONS_FILE = "captions.json";
/** A one-page mock is index.html, as Hub keeps it. */
const PAGE_FILE = "index.html";
const PARALLEL = 4;

/** A one-line, bounded, printable piece of Hub's (or Den's) answer. */
export const oneLine = (s: string): string =>
  s
    .replace(/[^\x20-\x7e]+/g, " ")
    .trim()
    .slice(0, 400);

/**
 * `hub:<slug>`, `hub:<slug>@v3`, `hub:<slug>@latest` (or the same without
 * `hub:`). Null when it isn't one.
 */
export function parseHubRef(
  ref: string,
): { slug: string; version: string | null } | null {
  const m = /^(?:hub:)?([^@\s]+)(?:@(v?[1-9][0-9]{0,8}|latest))?$/.exec(
    ref.trim(),
  );
  if (!m || !SLUG.test(m[1])) return null;
  const v = m[2] ?? null;
  return { slug: m[1], version: v ? v.replace(/^v/, "") : null };
}

/**
 * Whether a path from Hub may be written under a folder: relative, plain
 * segments only (no "", ".", ".."), no backslash, drive letter or NUL.
 */
export function safeRelPath(p: unknown): p is string {
  if (typeof p !== "string" || !p || p.length > 400) return false;
  if (/[\\\0]/.test(p) || p.startsWith("/") || /^[A-Za-z]:/.test(p))
    return false;
  return p.split("/").every((s) => s !== "" && s !== "." && s !== "..");
}

const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");

/** One call to Hub through Den's proxy; throws HubFilesError unless 2xx. */
export async function hubSend(
  via: HubVia,
  method: string,
  p: string,
  body?: Uint8Array | string,
  type?: string,
): Promise<Response> {
  const base = `${via.denBase.replace(/\/+$/, "")}/hub`;
  const f: Fetch = via.fetch ?? ((u, i) => fetch(u, i));
  let res: Response;
  try {
    res = await f(`${base}${p}`, {
      method,
      headers: {
        authorization: `Bearer ${via.token}`,
        accept: "application/json",
        ...(type ? { "content-type": type } : {}),
      },
      ...(body !== undefined ? { body } : {}),
      redirect: "manual",
    });
  } catch {
    throw new HubFilesError(
      `Den didn't answer at ${via.denBase}. Is it running (\`${product().cli} web up\`)?`,
    );
  }
  if (res.ok) return res;
  const text = await res.text().catch(() => "");
  let said: { error?: unknown; latest?: unknown } = {};
  try {
    said = JSON.parse(text) as typeof said;
  } catch {
    /* not JSON: its text is the error */
  }
  const words =
    typeof said.error === "string" ? said.error : text.slice(0, 300);
  throw new HubFilesError(
    `${method} ${p}: ${res.status} ${oneLine(words)}`,
    res.status === 409 && Number.isSafeInteger(said.latest)
      ? (said.latest as number)
      : undefined,
  );
}

/** Run `job` over `items`, `n` at a time; the first failure stops the rest. */
async function inParallel<T>(
  items: readonly T[],
  n: number,
  job: (item: T) => Promise<void>,
): Promise<void> {
  const queue = [...items];
  let failed = false;
  const worker = async () => {
    for (
      let it = queue.shift();
      it !== undefined && !failed;
      it = queue.shift()
    )
      await job(it).catch((e: unknown) => {
        failed = true;
        throw e;
      });
  };
  await Promise.all(Array.from({ length: Math.max(1, n) }, worker));
}

interface Limits {
  file_bytes: number;
  bundle_bytes: number;
  files: number;
}

interface VersionAnswer {
  slug?: unknown;
  kind?: unknown;
  n?: unknown;
  entry?: unknown;
  note?: unknown;
  files?: unknown;
  limits?: Partial<Limits>;
}

const versionPath = (slug: string, n: string | number) =>
  `/api/artifacts/${encodeURIComponent(slug)}/versions/${n}`;

async function getVersion(
  via: HubVia,
  slug: string,
  n: string,
): Promise<VersionAnswer> {
  return (await (
    await hubSend(via, "GET", versionPath(slug, n))
  ).json()) as VersionAnswer;
}

const mb = (n: number) =>
  `${(n / 1024 / 1024).toFixed(n < 1024 * 1024 ? 2 : 0)} MB`;

interface LocalFile {
  path: string;
  abs: string;
  sha256: string;
  size: number;
  caption?: string;
}

/** The files a put sends: a folder's (dot files and captions.json left out), or one file. */
function localFiles(src: string): LocalFile[] {
  let st: fs.Stats;
  try {
    st = fs.statSync(src);
  } catch {
    throw new HubFilesError(`${src}: no such file or folder`);
  }
  const hashed = (rel: string, abs: string): LocalFile => {
    const b = fs.readFileSync(abs);
    return { path: rel, abs, sha256: sha256(b), size: b.length };
  };
  if (st.isFile()) {
    const name = path.basename(src);
    // A one-page mock stays one (Hub keeps it as index.html).
    return [hashed(/\.html?$/i.test(name) ? PAGE_FILE : name, src)];
  }
  if (!st.isDirectory())
    throw new HubFilesError(`${src}: not a file or a folder`);
  const out: LocalFile[] = [];
  const walk = (dir: string, rel: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith(".")) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      const abs = path.join(dir, e.name);
      if (e.isSymbolicLink())
        throw new HubFilesError(
          `${r} is a link: put the file itself, not a link to it`,
        );
      if (e.isDirectory()) walk(abs, r);
      else if (e.isFile() && r !== CAPTIONS_FILE) out.push(hashed(r, abs));
    }
  };
  walk(src, "");
  if (!out.length) throw new HubFilesError(`${src}: no files to put`);
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const capFile = path.join(src, CAPTIONS_FILE);
  if (fs.existsSync(capFile)) {
    let caps: unknown;
    try {
      caps = JSON.parse(fs.readFileSync(capFile, "utf8"));
    } catch {
      throw new HubFilesError(
        `${CAPTIONS_FILE}: not JSON ({ "<path>": "<caption>" })`,
      );
    }
    if (!caps || typeof caps !== "object" || Array.isArray(caps))
      throw new HubFilesError(
        `${CAPTIONS_FILE}: one caption per path, { "<path>": "<caption>" }`,
      );
    for (const [p, c] of Object.entries(caps as Record<string, unknown>)) {
      const f = out.find((x) => x.path === p);
      if (!f || typeof c !== "string")
        throw new HubFilesError(
          `${CAPTIONS_FILE}: "${oneLine(p)}" isn't a file here, or its caption isn't text`,
        );
      f.caption = c;
    }
  }
  return out;
}

export interface PutAsk {
  /** A folder, or one file. */
  src: string;
  slug: string;
  note?: string;
  /** The bundle's page it opens on (a mock of several files). */
  entry?: string;
  /** The version this change was made on; default Hub's latest. */
  base?: number;
}

export interface PutResult {
  pointer: string;
  url: string | null;
  n: number;
  files: number;
  sent: number;
  bytes: number;
}

/** `hub put`: one new version of `slug` from `src`, sent in parts. */
export async function hubPut(
  ask: PutAsk,
  via: HubVia,
  progress?: (line: string) => void,
): Promise<PutResult> {
  const files = localFiles(ask.src);
  const latest = await getVersion(via, ask.slug, "latest");
  const lim = latest.limits ?? {};
  const total = files.reduce((s, f) => s + f.size, 0);
  if (Number.isSafeInteger(lim.files) && files.length > lim.files!)
    throw new HubFilesError(
      `${files.length} files is over Hub's limit of ${lim.files} a version`,
    );
  for (const f of files)
    if (Number.isSafeInteger(lim.file_bytes) && f.size > lim.file_bytes!)
      throw new HubFilesError(
        `${f.path} is ${mb(f.size)}, over Hub's ${mb(lim.file_bytes!)} a file`,
      );
  if (Number.isSafeInteger(lim.bundle_bytes) && total > lim.bundle_bytes!)
    throw new HubFilesError(
      `the files come to ${mb(total)}, over Hub's ${mb(lim.bundle_bytes!)} a version`,
    );
  const latestN = Number(latest.n);
  const base = ask.base ?? latestN;
  let entry = ask.entry;
  if (entry !== undefined && !files.some((f) => f.path === entry))
    throw new HubFilesError(`--entry ${oneLine(entry)} isn't one of the files`);
  if (entry === undefined && files.length > 1 && latest.kind === "mock") {
    if (files.some((f) => f.path === PAGE_FILE)) entry = PAGE_FILE;
    else
      throw new HubFilesError(
        "a mock of several files needs its entry: the .html page it opens on (--entry)",
      );
  }
  const moved = (e: unknown): never => {
    if (
      e instanceof HubFilesError &&
      e.latest !== undefined &&
      e.latest !== base
    )
      throw new HubFilesError(
        `hub:${ask.slug} moved: Hub has it at v${e.latest}, and this put was made on v${base}. ` +
          `Nothing was published. Pull hub:${ask.slug}@v${e.latest}, make the change on it, and put again on base ${e.latest}.`,
        e.latest,
      );
    throw e;
  };
  const draft = (await (
    await hubSend(
      via,
      "POST",
      `/api/artifacts/${encodeURIComponent(ask.slug)}/versions`,
      JSON.stringify({
        base,
        ...(ask.note !== undefined ? { note: ask.note } : {}),
        ...(entry !== undefined ? { entry } : {}),
        files: files.map((f) => ({
          path: f.path,
          sha256: f.sha256,
          size: f.size,
          ...(f.caption !== undefined ? { caption: f.caption } : {}),
        })),
      }),
      "application/json",
    ).catch(moved)
  ).json()) as { draft?: unknown; missing?: unknown };
  const id = String(draft.draft ?? "");
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id))
    throw new HubFilesError("Hub's answer has no draft id");
  const bySha = new Map(files.map((f) => [f.sha256, f]));
  const missing = Array.isArray(draft.missing) ? draft.missing.map(String) : [];
  for (const s of missing)
    if (!bySha.has(s))
      throw new HubFilesError("Hub asked for a file that isn't in this put");
  progress?.(`draft ${id}: ${files.length} files, ${missing.length} to send`);
  let sent = 0;
  await inParallel(missing, via.parallel ?? PARALLEL, async (s) => {
    const f = bySha.get(s)!;
    const bytes = fs.readFileSync(f.abs);
    if (bytes.length !== f.size || sha256(bytes) !== f.sha256)
      throw new HubFilesError(
        `${f.path} changed while it was being put: put it again`,
      );
    await hubSend(
      via,
      "PUT",
      `/api/artifacts/${encodeURIComponent(ask.slug)}/drafts/${id}/files/${s}`,
      new Uint8Array(bytes),
      "application/octet-stream",
    );
    sent++;
  });
  const done = (await (
    await hubSend(
      via,
      "POST",
      `/api/artifacts/${encodeURIComponent(ask.slug)}/drafts/${id}/commit`,
    ).catch(moved)
  ).json()) as { n?: unknown; pointer?: unknown; url?: unknown };
  const n = Number(done.n);
  if (!Number.isSafeInteger(n) || n < 1)
    throw new HubFilesError("Hub's answer to the commit has no version");
  const pointer =
    typeof done.pointer === "string" && /^hub:\S+@v\d+$/.test(done.pointer)
      ? done.pointer
      : `hub:${ask.slug}@v${n}`;
  return {
    pointer,
    url: typeof done.url === "string" ? oneLine(done.url) : null,
    n,
    files: files.length,
    sent,
    bytes: total,
  };
}

export interface PullAsk {
  slug: string;
  /** A version number, or "latest". */
  version: string;
  dir: string;
}

export interface PullResult {
  pointer: string;
  n: number;
  kind: string | null;
  entry: string | null;
  files: number;
  bytes: number;
  dir: string;
}

interface HubFile {
  path: string;
  sha256: string;
  size: number;
  caption?: string;
}

/** `hub pull`: a version's files into `dir`, each checked against its sha256. */
export async function hubPull(ask: PullAsk, via: HubVia): Promise<PullResult> {
  const v = await getVersion(via, ask.slug, ask.version);
  const n = Number(v.n);
  if (!Number.isSafeInteger(n) || n < 1)
    throw new HubFilesError("Hub's answer has no version number");
  if (!Array.isArray(v.files))
    throw new HubFilesError("Hub's answer has no file list");
  // Every path is checked before anything is fetched or written.
  const files: HubFile[] = [];
  const seen = new Set<string>();
  for (const raw of v.files as Record<string, unknown>[]) {
    const p = raw?.path;
    if (!safeRelPath(p))
      throw new HubFilesError(
        `Hub listed a path Den won't write: ${JSON.stringify(oneLine(String(p)))} (a path is relative, with no ".."). Nothing was written.`,
      );
    if (seen.has(p.toLowerCase()))
      throw new HubFilesError(`Hub listed ${p} twice. Nothing was written.`);
    seen.add(p.toLowerCase());
    if (typeof raw.sha256 !== "string" || !SHA.test(raw.sha256))
      throw new HubFilesError(
        `${p}: Hub's sha256 isn't one. Nothing was written.`,
      );
    if (!Number.isSafeInteger(raw.size) || (raw.size as number) < 0)
      throw new HubFilesError(
        `${p}: Hub's size isn't one. Nothing was written.`,
      );
    files.push({
      path: p,
      sha256: raw.sha256,
      size: raw.size as number,
      ...(typeof raw.caption === "string" ? { caption: raw.caption } : {}),
    });
  }
  const root = path.resolve(ask.dir);
  fs.mkdirSync(root, { recursive: true });
  let bytes = 0;
  await inParallel(files, via.parallel ?? PARALLEL, async (f) => {
    const res = await hubSend(
      via,
      "GET",
      `${versionPath(ask.slug, n)}/files/${f.sha256}`,
    );
    const data = Buffer.from(await res.arrayBuffer());
    if (data.length !== f.size || sha256(data) !== f.sha256)
      throw new HubFilesError(
        `${f.path}: the bytes Hub sent don't match its sha256 and size; not written`,
      );
    const target = path.resolve(root, ...f.path.split("/"));
    if (!target.startsWith(root + path.sep))
      throw new HubFilesError(`${f.path}: outside ${root}; not written`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (fs.lstatSync(target, { throwIfNoEntry: false })?.isSymbolicLink())
      throw new HubFilesError(`${f.path} is a link here; not written`);
    fs.writeFileSync(target, data);
    bytes += data.length;
  });
  const caps = files.filter((f) => f.caption !== undefined);
  if (caps.length && !seen.has(CAPTIONS_FILE))
    fs.writeFileSync(
      path.join(root, CAPTIONS_FILE),
      JSON.stringify(
        Object.fromEntries(caps.map((f) => [f.path, f.caption])),
        null,
        2,
      ) + "\n",
    );
  return {
    pointer: `hub:${ask.slug}@v${n}`,
    n,
    kind: typeof v.kind === "string" ? v.kind : null,
    entry: typeof v.entry === "string" ? v.entry : null,
    files: files.length,
    bytes,
    dir: root,
  };
}
