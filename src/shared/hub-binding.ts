/**
 * Issue 726: which Hub this install's Hub state belongs to. Every hub/*
 * state file (the delivery seen-store: ids, last stream id and the held
 * queue; the inbox watch's `since`; the tools and links seen) and each
 * project's `hub_project` link are the Hub's that made them: its origin,
 * and the company it was connected for.
 *
 *   <state>/hub/bound.json   { url, origin, company?, at }
 *
 * A change of either archives them under hub/previous/<stamp>/ (with
 * from.json: which Hub, which Hub after, and every project's old link) and
 * starts fresh, so the old cursor is never sent to the new Hub and its held
 * comments are never typed or reported there. A web app's relayed message
 * (Den's own, never Hub's) stays queued. A cleared address keeps the state:
 * the same Hub again loses nothing.
 *
 *   <state>/hub/unrevoked/<id>.json  { id, url, at, why }  (+ <id>.token)
 *
 * A token an earlier Hub couldn't revoke (it didn't answer): the record
 * doctor lists, and the token itself (0600) kept only to retry the revoke
 * on the Hub that issued it. Never shown, never sent anywhere else.
 */
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { EMBED_PREFIX } from "./hub-delivery.js";
import type { WorkspacesFile } from "./types/index.js";
import { WORKSPACE_NAME_MAX } from "./workspace-name.js";
import { writeFileAtomic } from "./atomic-write.js";
import { readStateJson } from "./state-backup.js";

/** The hub/* files that belong to one Hub (archived on a change). */
export const HUB_STATE_FILES = [
  "deliveries-seen.json",
  "inbox-watch.json",
  "tools-seen.json",
  "links-seen.json",
  "deliveries-health.json",
] as const;

export interface HubBinding {
  url: string;
  origin: string;
  /** The company's slug (else its name), once a Connect named it. */
  company?: string;
  at: string;
}

/** The Hub as configured now; `company` only when Hub just said it. */
export interface HubNow {
  url: string | null;
  company?: string;
}

export interface ArchivedHub {
  stamp: string;
  dir: string;
  from: HubBinding | null;
  to: HubNow;
  at: string;
  /** The projects that had a link to the old Hub (now unlinked). */
  projects: string[];
}

export interface BindHubDeps {
  stateDir: string;
  now?: () => Date;
  readWorkspaces: () => WorkspacesFile;
  writeWorkspaces: (f: WorkspacesFile, by: string) => void;
}

const hubDir = (stateDir: string) => path.join(stateDir, "hub");
const boundFile = (stateDir: string) =>
  path.join(hubDir(stateDir), "bound.json");
const previousDir = (stateDir: string) =>
  path.join(hubDir(stateDir), "previous");
const unrevokedDir = (stateDir: string) =>
  path.join(hubDir(stateDir), "unrevoked");

/** scheme://host[:port] of a Hub address, lower case; "" when not one. */
export function hubOrigin(url: string): string {
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) ? u.origin : "";
  } catch {
    return "";
  }
}

function writeJson(file: string, v: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeFileAtomic(file, JSON.stringify(v, null, 1) + "\n", { mode: 0o600 });
}

function readJson(stateDir: string, file: string): unknown {
  // Issue 786: a file that can't be parsed is kept in backup, not reset.
  const r = readStateJson(stateDir, file);
  return r.ok ? r.value : null;
}

function parseBinding(v: unknown): HubBinding | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (typeof o.url !== "string" || typeof o.origin !== "string") return null;
  return {
    url: o.url,
    origin: o.origin,
    ...(typeof o.company === "string" && o.company
      ? { company: o.company }
      : {}),
    at: typeof o.at === "string" ? o.at : "",
  };
}

/** The Hub this install's state belongs to, or null (none yet). */
export function readHubBinding(stateDir: string): HubBinding | null {
  return parseBinding(readJson(stateDir, boundFile(stateDir)));
}

/**
 * What `now` means for state bound to `bound`: `same` (keep it), `bind`
 * (record the Hub, or the company Connect just named, keeping the state:
 * an upgrade adopts what it finds), or `change` (archive, start fresh).
 */
export function decideHubBinding(
  bound: HubBinding | null,
  now: HubNow,
): "same" | "bind" | "change" {
  const origin = now.url ? hubOrigin(now.url) : "";
  if (!origin) return "same";
  if (!bound) return "bind";
  if (bound.origin !== origin) return "change";
  if (now.company && bound.company && now.company !== bound.company)
    return "change";
  if (now.company && !bound.company) return "bind";
  return "same";
}

/** A folder name from a time: 2026-11-20T10-00-00-000Z (unique). */
function newStamp(stateDir: string, at: Date): string {
  const base = at.toISOString().replace(/[:.]/g, "-");
  let s = base;
  for (let i = 2; fs.existsSync(path.join(previousDir(stateDir), s)); i++)
    s = `${base}-${i}`;
  return s;
}

/** Of a held block, only Den's own relayed web-app messages (EMBED_PREFIX). */
function ownHeld(held: unknown): unknown {
  if (!held || typeof held !== "object") return null;
  const h = held as {
    queue?: Record<string, unknown[]>;
    active?: Record<string, { ids?: unknown[] }>;
  };
  const isOwn = (id: unknown) =>
    typeof id === "string" && id.startsWith(EMBED_PREFIX);
  const queue: Record<string, unknown[]> = {};
  for (const [a, list] of Object.entries(h.queue ?? {})) {
    const keep = Array.isArray(list)
      ? list.filter((r) => isOwn((r as { id?: unknown })?.id))
      : [];
    if (keep.length) queue[a] = keep;
  }
  const active: Record<string, unknown> = {};
  for (const [a, v] of Object.entries(h.active ?? {}))
    if (Array.isArray(v?.ids) && v.ids.length && v.ids.every(isOwn))
      active[a] = v;
  return Object.keys(queue).length || Object.keys(active).length
    ? { queue, active }
    : null;
}

/** Move the Hub's state into `dir`; a fresh seen-store keeps Den's relays. */
function archiveFiles(stateDir: string, dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const f of HUB_STATE_FILES) {
    const from = path.join(hubDir(stateDir), f);
    if (!fs.existsSync(from)) continue;
    fs.renameSync(from, path.join(dir, f));
  }
  const seen = readJson(stateDir, path.join(dir, "deliveries-seen.json")) as {
    held?: unknown;
  } | null;
  const held = ownHeld(seen?.held);
  if (held)
    writeJson(path.join(hubDir(stateDir), "deliveries-seen.json"), {
      ids: [],
      last: null,
      held,
    });
}

/** Unlink every project (as an unlink does: the name shown stays). */
function unlinkAll(d: BindHubDeps): Record<string, unknown> {
  const file = d.readWorkspaces();
  const links: Record<string, unknown> = {};
  for (const [ws, cfg] of Object.entries(file.workspaces ?? {})) {
    if (!cfg) continue;
    const c = cfg as unknown as Record<string, unknown>;
    if (!("hub_project" in c || "hub_rename" in c || "hub_create" in c))
      continue;
    if (c.hub_project) links[ws] = c.hub_project;
    const next = { ...c };
    const name = (c.hub_project as { name?: unknown } | undefined)?.name;
    if (c.hub_project && typeof name === "string" && name.trim())
      next.name = name.trim().slice(0, WORKSPACE_NAME_MAX);
    delete next.hub_project;
    delete next.hub_rename;
    delete next.hub_create;
    (file.workspaces as Record<string, unknown>)[ws] = next;
  }
  if (Object.keys(file.workspaces ?? {}).length)
    d.writeWorkspaces(file, "Hub changed (issue 726)");
  return links;
}

/**
 * Bind this install's Hub state to `now`. A change archives every hub/*
 * state file and every project link under hub/previous/<stamp>/ and starts
 * fresh. The caller stops whatever holds that state in memory first.
 */
export function bindHub(
  d: BindHubDeps,
  now: HubNow,
): { kind: "same" | "bind" | "change"; archived?: ArchivedHub } {
  const bound = readHubBinding(d.stateDir);
  const kind = decideHubBinding(bound, now);
  if (kind === "same") return { kind };
  const at = (d.now ?? (() => new Date()))();
  const next: HubBinding = {
    url: now.url!.replace(/\/+$/, ""),
    origin: hubOrigin(now.url!),
    ...(now.company
      ? { company: now.company }
      : kind === "bind" && bound?.company
        ? { company: bound.company }
        : {}),
    at: at.toISOString(),
  };
  if (kind === "bind") {
    writeJson(boundFile(d.stateDir), next);
    return { kind };
  }
  const stamp = newStamp(d.stateDir, at);
  const dir = path.join(previousDir(d.stateDir), stamp);
  archiveFiles(d.stateDir, dir);
  const links = unlinkAll(d);
  const archived: ArchivedHub = {
    stamp,
    dir,
    from: bound,
    to: { url: next.url, ...(now.company ? { company: now.company } : {}) },
    at: at.toISOString(),
    projects: Object.keys(links),
  };
  writeJson(path.join(dir, "from.json"), {
    from: bound,
    to: archived.to,
    at: archived.at,
    links,
  });
  writeJson(boundFile(d.stateDir), next);
  return { kind, archived };
}

/** The earlier Hubs' archives, oldest first. */
export function listPreviousHubs(stateDir: string): ArchivedHub[] {
  let names: string[];
  try {
    names = fs.readdirSync(previousDir(stateDir)).sort();
  } catch {
    return [];
  }
  const out: ArchivedHub[] = [];
  for (const stamp of names) {
    const dir = path.join(previousDir(stateDir), stamp);
    const v = readJson(stateDir, path.join(dir, "from.json")) as Record<
      string,
      unknown
    > | null;
    if (!v) continue;
    const to = (v.to ?? {}) as HubNow;
    out.push({
      stamp,
      dir,
      from: parseBinding(v.from),
      to: { url: typeof to.url === "string" ? to.url : null },
      at: typeof v.at === "string" ? v.at : "",
      projects: Object.keys((v.links as Record<string, unknown>) ?? {}),
    });
  }
  return out;
}

/**
 * Issue 646: the link project `ws` had on the last earlier Hub that it had
 * one on (Connect's review says "was linked to … on …"), or null.
 */
export function previousLinkOf(
  stateDir: string,
  ws: string,
): { name: string; origin: string; company?: string } | null {
  for (const a of listPreviousHubs(stateDir).reverse()) {
    if (!a.projects.includes(ws) || !a.from) continue;
    const v = readJson(stateDir, path.join(a.dir, "from.json")) as {
      links?: Record<string, { name?: unknown; slug?: unknown }>;
    } | null;
    const l = v?.links?.[ws];
    const name =
      typeof l?.name === "string" && l.name
        ? l.name
        : typeof l?.slug === "string"
          ? l.slug
          : "";
    if (!name) continue;
    return {
      name: name.slice(0, 200),
      origin: a.from.origin,
      ...(a.from.company ? { company: a.from.company } : {}),
    };
  }
  return null;
}

export interface UnrevokedToken {
  id: string;
  url: string;
  at: string;
  why: string;
}

/** Keep a token `url` couldn't revoke: the record, and the token to retry. */
export function recordUnrevoked(
  stateDir: string,
  u: { url: string; why: string; token?: string },
  at: Date = new Date(),
): UnrevokedToken {
  const id = crypto.randomBytes(6).toString("hex");
  const rec: UnrevokedToken = {
    id,
    url: u.url,
    at: at.toISOString(),
    why: u.why.replace(/\s+/g, " ").slice(0, 300),
  };
  const dir = unrevokedDir(stateDir);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  if (u.token) {
    const f = path.join(dir, `${id}.token`);
    writeFileAtomic(f, `${u.token}\n`, { mode: 0o600 });
  }
  writeJson(path.join(dir, `${id}.json`), rec);
  return rec;
}

/** The tokens earlier Hubs couldn't revoke, oldest first. */
export function readUnrevoked(stateDir: string): UnrevokedToken[] {
  let names: string[];
  try {
    names = fs.readdirSync(unrevokedDir(stateDir));
  } catch {
    return [];
  }
  return names
    .filter((n) => n.endsWith(".json"))
    .map((n) => readJson(stateDir, path.join(unrevokedDir(stateDir), n)))
    .filter(
      (v): v is UnrevokedToken =>
        !!v &&
        typeof (v as UnrevokedToken).id === "string" &&
        typeof (v as UnrevokedToken).url === "string",
    )
    .sort((a, b) => a.at.localeCompare(b.at));
}

const ID_RE = /^[0-9a-f]{12}$/;

/** The kept token for record `id`, for a retry only; null when none. */
export function unrevokedToken(stateDir: string, id: string): string | null {
  if (!ID_RE.test(id)) return null;
  try {
    const t = fs
      .readFileSync(path.join(unrevokedDir(stateDir), `${id}.token`), "utf8")
      .trim();
    return t || null;
  } catch {
    return null;
  }
}

/** The Hub revoked it (or had): forget the record and the token. */
export function dropUnrevoked(stateDir: string, id: string): void {
  if (!ID_RE.test(id)) return;
  for (const ext of [".token", ".json"])
    fs.rmSync(path.join(unrevokedDir(stateDir), `${id}${ext}`), {
      force: true,
    });
}
