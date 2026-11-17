/**
 * Issue 385 / 395: what `edge up` did to the edge container, and why.
 *
 * The container's own spec (image, ports, command flags, mounts, networks)
 * is compared before and after: the running one as `docker inspect` gives
 * it, the new one as Den renders it (render.ts). Routes and TLS files live
 * in the watched dynamic folder and are not part of it: Traefik reloads
 * those by itself. Pure; runtime.ts does the docker calls.
 */
import * as path from "path";
import {
  edgeCommand,
  edgeHttps,
  edgeNames,
  dockerProxyName,
  EDGE_ACCESS_DIR,
} from "./render.js";
import type { EdgeConfig } from "./types.js";

/** An edge container's own spec. */
export interface EdgeSpec {
  /** The image reference as given (a tag, or a digest). */
  image: string;
  /** The image id it resolves to here, when known. */
  imageId: string | null;
  command: string[];
  /** Container port → host port ("80" → "7777"). */
  ports: Record<string, string>;
  /** Mount target → host source. */
  mounts: Record<string, string>;
  networks: string[];
}

/** The running container, as `docker inspect` says. */
export interface RunningEdge {
  id: string;
  running: boolean;
  startedAt: string | null;
  spec: EdgeSpec;
}

/** One change between two specs, as words: `<field>: <old> → <new>`. */
export interface EdgeChange {
  field: string;
  old: string;
  new: string;
}

export type EdgeUpKind = "started" | "current" | "recreated";

/** What `edge up` did. */
export interface EdgeUpOutcome {
  kind: EdgeUpKind;
  /** Why it was recreated ([] when not, or when Den can't tell). */
  changes: EdgeChange[];
  /** About how long the edge was unreachable (recreated only). */
  downSeconds: number | null;
}

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" ? (v as Record<string, unknown>) : {};
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** A `docker inspect <container>` answer (its JSON array) as a RunningEdge. */
export function parseEdgeInspect(json: string): RunningEdge | null {
  let v: unknown;
  try {
    v = JSON.parse(json);
  } catch {
    return null;
  }
  const c = obj(Array.isArray(v) ? v[0] : v);
  if (!str(c.Id)) return null;
  const config = obj(c.Config);
  const state = obj(c.State);
  const host = obj(c.HostConfig);
  const ports: Record<string, string> = {};
  for (const [k, binds] of Object.entries(obj(host.PortBindings))) {
    const first = Array.isArray(binds) ? obj(binds[0]) : {};
    if (str(first.HostPort))
      ports[k.replace(/\/tcp$/, "")] = str(first.HostPort);
  }
  const mounts: Record<string, string> = {};
  for (const m of Array.isArray(c.Mounts) ? c.Mounts : []) {
    const mm = obj(m);
    if (str(mm.Destination)) mounts[str(mm.Destination)] = str(mm.Source);
  }
  const cmd = Array.isArray(config.Cmd)
    ? (config.Cmd as unknown[]).filter(
        (x): x is string => typeof x === "string",
      )
    : [];
  return {
    id: str(c.Id),
    running: str(state.Status) === "running",
    startedAt: str(state.StartedAt) || null,
    spec: {
      image: str(config.Image),
      imageId: str(c.Image) || null,
      command: cmd,
      ports,
      mounts,
      networks: Object.keys(obj(obj(c.NetworkSettings).Networks)).sort(),
    },
  };
}

/**
 * The spec Den renders for the edge (renderEdgeCompose's edge service),
 * with its relative mounts resolved against `root` (compose.yml's dir).
 */
export function renderedEdgeSpec(
  cfg: EdgeConfig,
  root: string,
  imageId: string | null = null,
): EdgeSpec {
  const n = edgeNames(cfg.org);
  const proxy = dockerProxyName(cfg.org);
  const labels = cfg.dockerLabels;
  const external = [
    ...new Set([...(labels ? [labels.network] : []), ...cfg.networks]),
  ].filter((x) => x !== n.network && x !== proxy);
  const ports: Record<string, string> = {};
  if (cfg.ports) {
    ports["80"] = String(cfg.ports.http);
    if (edgeHttps(cfg)) ports["443"] = String(cfg.ports.https);
  }
  const mounts: Record<string, string> = {
    "/etc/edge/dynamic": path.join(root, "dynamic"),
  };
  if (cfg.tls.strategy === "mkcert")
    mounts["/etc/edge/certs"] = path.join(root, "certs");
  for (const [hostPath, target] of Object.entries(cfg.mounts))
    mounts[target] = hostPath;
  if (cfg.accessLog?.enabled)
    mounts[EDGE_ACCESS_DIR] = path.join(root, "access");
  return {
    image: cfg.image,
    imageId,
    command: edgeCommand(cfg),
    ports,
    mounts,
    networks: [n.network, ...(labels ? [proxy] : []), ...external].sort(),
  };
}

const NONE = "none";
/** A digest or image id, short enough to read. */
const shortId = (s: string) =>
  s.replace(/(sha256:[0-9a-f]{12})[0-9a-f]+/g, "$1");
/** `--key=value` → [key, value]; a bare `--flag` is on. */
const flag = (s: string): [string, string] => {
  const i = s.indexOf("=");
  return i < 0 ? [s, "on"] : [s.slice(0, i), s.slice(i + 1)];
};

function mapChanges(
  a: Record<string, string>,
  b: Record<string, string>,
  field: (k: string) => string,
  norm: (v: string) => string = (v) => v,
): EdgeChange[] {
  const out: EdgeChange[] = [];
  for (const k of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
    const o = a[k] === undefined ? NONE : a[k];
    const nw = b[k] === undefined ? NONE : b[k];
    if (norm(o) !== norm(nw)) out.push({ field: field(k), old: o, new: nw });
  }
  return out;
}

/**
 * What differs between the running spec and the rendered one: the image
 * (its reference, or the id the same reference now resolves to), each
 * command flag, each published port, each mount, the networks. [] when
 * nothing does. `real` normalizes a host path (a symlinked temp dir).
 */
export function edgeSpecChanges(
  running: EdgeSpec,
  rendered: EdgeSpec,
  real: (p: string) => string = (p) => p,
): EdgeChange[] {
  const out: EdgeChange[] = [];
  if (running.image !== rendered.image)
    out.push({
      field: "image",
      old: shortId(running.image),
      new: shortId(rendered.image),
    });
  else if (
    running.imageId &&
    rendered.imageId &&
    running.imageId !== rendered.imageId
  )
    out.push({
      field: "image",
      old: `${running.image} (${shortId(running.imageId)})`,
      new: `${rendered.image} (${shortId(rendered.imageId)})`,
    });
  // A flag given twice: the last one counts, as Traefik reads them.
  const flags = (cmd: string[]) =>
    Object.fromEntries(cmd.map(flag)) as Record<string, string>;
  out.push(
    ...mapChanges(flags(running.command), flags(rendered.command), (k) => k),
  );
  out.push(...mapChanges(running.ports, rendered.ports, (k) => `port ${k}`));
  out.push(
    ...mapChanges(
      running.mounts,
      rendered.mounts,
      (k) => `mount ${k}`,
      (v) => (v === NONE ? v : real(v.replace(/^\/host_mnt(?=\/)/, ""))),
    ),
  );
  const nets = (l: string[]) => [...l].sort().join(", ") || NONE;
  if (nets(running.networks) !== nets(rendered.networks))
    out.push({
      field: "networks",
      old: nets(running.networks),
      new: nets(rendered.networks),
    });
  return out;
}

/**
 * What `edge up` did, from the container before and after it:
 *  - none running before: started;
 *  - the same container, not restarted: up to date;
 *  - a new container (or a restart): recreated, with why and about how
 *    long it was down (from when `edge up` began to the new one's start).
 */
export function edgeUpOutcome(
  before: RunningEdge | null,
  after: RunningEdge | null,
  changes: EdgeChange[],
  t: { began: number; ended: number },
): EdgeUpOutcome {
  if (!before || !before.running)
    return { kind: "started", changes: [], downSeconds: null };
  if (after && after.id === before.id && after.startedAt === before.startedAt)
    return { kind: "current", changes: [], downSeconds: null };
  const started = after?.startedAt ? Date.parse(after.startedAt) : NaN;
  const ms =
    Number.isFinite(started) && started >= t.began
      ? started - t.began
      : t.ended - t.began;
  return {
    kind: "recreated",
    changes,
    downSeconds: Math.max(1, Math.round(ms / 1000)),
  };
}

/** The changes as one phrase: `image: a → b, port 80: 7777 → 8080`. */
export function edgeChangesText(changes: readonly EdgeChange[]): string {
  return changes.map((c) => `${c.field}: ${c.old} → ${c.new}`).join(", ");
}

/** `edge up`'s line for what it did (the page says the same, translated). */
export function edgeUpLine(o: EdgeUpOutcome): string {
  if (o.kind === "started") return "Edge started";
  if (o.kind === "current") return "Edge up to date, nothing restarted";
  const why = o.changes.length
    ? edgeChangesText(o.changes)
    : "its settings changed";
  return `Edge recreated because ${why}; it was unreachable for about ${o.downSeconds ?? 1} s`;
}
