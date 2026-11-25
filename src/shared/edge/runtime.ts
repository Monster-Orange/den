/**
 * Side effects for the edge: docker, files, and the TLS strategy's (tls.ts).
 * Thin on purpose — every routing decision lives in render.ts.
 */
import { prepareAccessRaw } from "./access-sweep.js";
import * as fs from "fs";
import * as path from "path";
import * as yaml from "yaml";
import { writeFileAtomic } from "../atomic-write.js";
import { must, sh } from "./exec.js";
import { readWebPort } from "./config.js";
import { probeIdentity } from "../den-identity.js";
import { getStateDir } from "../paths.js";
import { portInUse as portInUseAnywhere } from "../port-pick.js";
import { product } from "../product.js";
import { localhostOrigin } from "../web-session.js";
import {
  addressCheckSettings,
  cliLanguage,
  localIdentityKey,
  serverName,
} from "./address-check.js";
import { addressWord } from "./address-words.js";
import { portOwner, type PortOwner } from "./port-owner.js";
import {
  ensureEdgeProof,
  readEdgeProof,
  releaseEdgeTrust,
  rotateEdgeProof,
} from "./proof.js";
import {
  commandServesApi,
  droppedEdgeArgs,
  EDGE_PROOF_MIDDLEWARE_PREFIX,
  EDGE_ROOT_LABEL,
  edgeCommand,
  accessLogNoTraceNotice,
  edgeCommandDrift,
  edgeNames,
  renderEdgeCompose,
  renderEdgeDynamic,
  webRouteHosts,
} from "./render.js";
import {
  assertCaUsable,
  caDir,
  caTrusted,
  edgeTrust,
  edgeUntrust,
  sharedCa,
  tlsStrategyFor,
  warnImplicitTlsOnce,
} from "./tls.js";
import {
  edgeChangesText,
  edgeSpecChanges,
  edgeUpLine,
  edgeUpOutcome,
  parseEdgeInspect,
  renderedEdgeSpec,
  type EdgeUpOutcome,
  type RunningEdge,
} from "./spec.js";
import type { EdgeConfig } from "./types.js";

export { assertCaUsable, caDir, caTrusted, sharedCa };

/** Traefik watches these files: each is replaced whole (#380). */
function write(file: string, content: string): void {
  writeFileAtomic(file, content);
}

/**
 * H1: Den's generated dynamic file carries the edge's proof: 0600, and replaced
 * whole (a rename), so Traefik's watch never reads half of it.
 */
function writeSecret(file: string, content: string): void {
  writeFileAtomic(file, content, { mode: 0o600 });
}

/**
 * Den's generated dynamic-config file (routes, the proof, TLS). Named to
 * sort before every included file: Traefik's file provider reads the
 * dynamic folder in name order and keeps the first definition of a name,
 * so Den's own routers, services and transport are the ones in force.
 * syncIncluded refuses an include that would sort before it.
 */
export const EDGE_DYNAMIC_FILE = "000-den.yml";

/** Its name before: read when the new one isn't there yet, removed once it is. */
export const LEGACY_DYNAMIC_FILE = "edge.yml";

/** Den's generated dynamic file in `stateDir`. */
export const edgeDynamicFile = (stateDir: string): string =>
  path.join(stateDir, "dynamic", EDGE_DYNAMIC_FILE);

/** Den's generated dynamic file's text (or its older name's), or null: no edge set up here. */
export function readEdgeDynamic(stateDir: string): string | null {
  for (const f of [EDGE_DYNAMIC_FILE, LEGACY_DYNAMIC_FILE])
    try {
      return fs.readFileSync(path.join(stateDir, "dynamic", f), "utf8");
    } catch {
      /* the next name */
    }
  return null;
}

/** Write Den's generated dynamic file (0600, whole), then drop the older name. */
function writeEdgeDynamic(stateDir: string, text: string): void {
  writeSecret(edgeDynamicFile(stateDir), text);
  fs.rmSync(path.join(stateDir, "dynamic", LEGACY_DYNAMIC_FILE), {
    force: true,
  });
}

/**
 * H1 (0.4.48): at Den's start, an edge set up here gets Den's dynamic file
 * as this version renders it with the current proof: the file only, which
 * Traefik reloads by itself; nothing restarts. "current" only when the
 * file is exactly that render (under its own name), so a file an earlier
 * build wrote (another middleware name, the older file name) is written
 * again. No generated file here: no edge to sync (and no proof is made).
 *
 * A proof made before the current proof generation (proofIsCurrent) is
 * replaced first, once, on the first start of the version that raised it:
 * "rotated", and the file is rendered again with the new one.
 */
export function syncEdgeProof(
  cfg: EdgeConfig,
  ports: ReadonlySet<number>,
): "written" | "rotated" | "current" | "no-edge" {
  if (readEdgeDynamic(cfg.stateDir) === null) return "no-edge";
  const have = readEdgeProof(cfg.stateDir);
  const proof = ensureEdgeProof(cfg.stateDir);
  const want = renderEdgeDynamic(cfg, { proof, ports });
  let now: string | null = null;
  try {
    now = fs.readFileSync(edgeDynamicFile(cfg.stateDir), "utf8");
  } catch {
    /* not under its own name yet */
  }
  if (have === proof && now === want) return "current";
  writeEdgeDynamic(cfg.stateDir, want);
  return have && proof !== have ? "rotated" : "written";
}

/**
 * Issue 728: the marker that the edge's proof was rotated once after agents
 * lost read access to the edge's state folder. In that folder, so installs
 * sharing one edge rotate it once. No secret in it.
 */
const ROTATED = "proof-rotated.json";

/** When the once-only rotation ran, or null if it hasn't. */
export function edgeProofRotation(cfg: Pick<EdgeConfig, "stateDir">): {
  rotatedAt: string | null;
} {
  try {
    const v = JSON.parse(
      fs.readFileSync(path.join(cfg.stateDir, ROTATED), "utf8"),
    ) as { at?: unknown };
    return { rotatedAt: typeof v.at === "string" ? v.at : null };
  } catch {
    return { rotatedAt: null };
  }
}

/**
 * Issue 728: rotate the edge's proof once. A new proof, and Den's dynamic
 * file (when the edge is set up here) rewritten with it, which Traefik reloads by
 * itself: nothing restarts and sessions are kept (until Traefik reloads,
 * a few seconds, edge requests aren't proved, so a page loaded then asks to
 * sign in). No proof yet (an edge never started here): nothing is
 * written, not even the marker; a proof made later is made after agents
 * lost read access, and one that turns up unmarked is rotated once.
 * The proof (0600, renamed in whole) comes first, the dynamic file next, the marker
 * last: a crash between them fails closed (edge requests stop proving, so
 * people sign in), the next start's syncEdgeProof puts the current proof in
 * the dynamic file, and with no marker the rotation runs again. The web server's
 * check re-reads the proof file when it changes: no restart.
 */
export function rotateEdgeProofOnce(
  cfg: EdgeConfig,
  ports: ReadonlySet<number>,
  now: Date = new Date(),
): "rotated" | "done" | "no-edge" {
  if (edgeProofRotation(cfg).rotatedAt) return "done";
  if (readEdgeProof(cfg.stateDir) === null) return "no-edge";
  const proof = rotateEdgeProof(cfg.stateDir);
  if (readEdgeDynamic(cfg.stateDir) !== null)
    writeEdgeDynamic(cfg.stateDir, renderEdgeDynamic(cfg, { proof, ports }));
  markEdgeProofRotated(cfg, now);
  return "rotated";
}

/**
 * Issue 728: an edge recreated with a new proof (an API edge stopped at
 * Den's start, edge/start.ts) is the once-only rotation too: mark it, so
 * the next start doesn't rotate again.
 */
export function markEdgeProofRotated(
  cfg: Pick<EdgeConfig, "stateDir">,
  now: Date = new Date(),
): void {
  writeFileAtomic(
    path.join(cfg.stateDir, ROTATED),
    JSON.stringify({ at: now.toISOString(), rotated: true }) + "\n",
    { mode: 0o600 },
  );
}

/**
 * Issue 728: the rotation as Den's start runs it. No edge config here is
 * quiet ("no-config"); a config whose rotation throws (a write refused,
 * say) is warned with the reason, never swallowed ("failed"), and the next
 * start tries again (no marker was written).
 */
export function rotateEdgeProofAtStart(o: {
  readConfig: () => EdgeConfig;
  ports: ReadonlySet<number>;
  now?: Date;
  rotate?: typeof rotateEdgeProofOnce;
  onRotated: () => void;
  warn: (message: string) => void;
}): "rotated" | "done" | "no-edge" | "no-config" | "failed" {
  let cfg: EdgeConfig;
  try {
    cfg = o.readConfig();
  } catch {
    return "no-config";
  }
  try {
    const r = (o.rotate ?? rotateEdgeProofOnce)(cfg, o.ports, o.now);
    if (r === "rotated") o.onRotated();
    return r;
  } catch (e) {
    o.warn(
      `the edge's proof was not rotated (the next start tries again): ${(e as Error).message}`,
    );
    return "failed";
  }
}

/**
 * Issue 728: the stacks (their Compose project folders) holding generated
 * secrets in the edge's state folder, which agents could read before. Only
 * names: never a value. They're never regenerated here (that would lock a
 * stack out of its data); doctor names each for its project's agent.
 */
export function stacksWithGeneratedSecrets(
  cfg: Pick<EdgeConfig, "stateDir">,
): string[] {
  const root = path.join(cfg.stateDir, "stacks");
  let names: string[] = [];
  try {
    names = fs.readdirSync(root);
  } catch {
    return [];
  }
  return names
    .filter((n) => fs.existsSync(path.join(root, n, "generated.env")))
    .sort();
}

function ensureNetwork(name: string): void {
  if (sh("docker", ["network", "inspect", name]).code !== 0)
    must("docker", ["network", "create", name]);
}

export function containerState(name: string): string {
  const r = sh("docker", ["inspect", "-f", "{{.State.Status}}", name]);
  return r.code === 0 ? r.out : "absent";
}

/**
 * Whether something holds `port` here, in any address family (issue 455:
 * port-pick.ts's one check; the edge's own 127.0.0.1-only copy missed an
 * IPv6-only or one-interface listener).
 */
export const portInUse = (port: number): Promise<boolean> =>
  portInUseAnywhere(port);

// ── Certificates (the edge.tls strategy, see tls.ts) ────────────────────────

/** Make sure the edge's cert exists, as its TLS strategy does it. */
export function ensureCerts(cfg: EdgeConfig): {
  issued: boolean;
  names: string[];
} {
  const r = tlsStrategyFor(cfg).capabilities.ensure(cfg);
  return { issued: r.issued, names: r.names };
}

/** `edge trust`: install the CA (mkcert only; prompts for a password). */
export function trustCa(cfg: EdgeConfig): number {
  return edgeTrust(cfg);
}

/** `edge untrust` (mkcert only; never a shared CA). */
export function untrustCa(cfg: EdgeConfig): number {
  return edgeUntrust(cfg);
}

// ── Included dynamic config ─────────────────────────────────────────────────

/** The dynamic-config files in `dir` to copy in (top level, YAML only). */
export function includeFiles(dir: string | null): string[] {
  if (!dir) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter(
      (e) =>
        e.isFile() &&
        /\.ya?ml$/.test(e.name) &&
        e.name !== EDGE_DYNAMIC_FILE &&
        e.name !== LEGACY_DYNAMIC_FILE,
    )
    .map((e) => e.name)
    .sort();
}

/**
 * Names the last sync copied in. Kept in the state dir, outside dynamic/,
 * so the watching Traefik never reads it.
 */
const INCLUDED_LEDGER = "included.json";

/** A stack's own route file (`stack-<project>.yml`, stacks/runtime.ts). */
export const isStackRoutes = (f: string): boolean =>
  /^stack-.*\.ya?ml$/.test(f);

/** Files other writers own in the dynamic directory: never copied over or pruned. */
export const isOwnedElsewhere = (f: string): boolean =>
  f === EDGE_DYNAMIC_FILE || f === LEGACY_DYNAMIC_FILE || isStackRoutes(f);

function readLedger(stateDir: string): string[] {
  try {
    const v: unknown = JSON.parse(
      fs.readFileSync(path.join(stateDir, INCLUDED_LEDGER), "utf-8"),
    );
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return []; // no ledger yet: nothing is known to be ours, so prune nothing
  }
}

/** The `http` sections whose names Traefik merges across files (first wins). */
const NAMED_SECTIONS = [
  "routers",
  "services",
  "middlewares",
  "serversTransports",
] as const;

/** Every name Den's own dynamic file defines for `cfg`, by section. */
function denDynamicNames(cfg: EdgeConfig): Set<string> {
  const doc = yaml.parse(renderEdgeDynamic(cfg)) as {
    http?: Record<string, Record<string, unknown> | undefined>;
  };
  const out = new Set<string>();
  for (const sec of NAMED_SECTIONS)
    for (const n of Object.keys(doc.http?.[sec] ?? {})) out.add(`${sec}.${n}`);
  return out;
}

/**
 * Refuse an included file (`f` in `dir`) that could stand in for what Den
 * renders: one that sorts before Den's own file (read first, it would win
 * every name it shares), one that defines a router, service, middleware or
 * servers transport of a name Den renders or of Den's own `den-` prefix,
 * or one that names the proof middleware at all. Files Den can't parse (a
 * Go template, which Traefik renders) are left to the order: Den's file is
 * read first, so its definitions win.
 */
function assertIncludeAllowed(
  dir: string,
  f: string,
  reserved: ReadonlySet<string>,
): void {
  if (f < EDGE_DYNAMIC_FILE)
    throw new Error(
      `edge.include: ${f} sorts before ${EDGE_DYNAMIC_FILE}, Den's own dynamic file, so Traefik would read it first and its names would win over Den's. Rename it (e.g. so it starts with a letter).`,
    );
  const text = fs.readFileSync(path.join(dir, f), "utf8");
  if (text.toLowerCase().includes(EDGE_PROOF_MIDDLEWARE_PREFIX))
    throw new Error(
      `edge.include: ${f} names ${EDGE_PROOF_MIDDLEWARE_PREFIX}, the middleware that adds the edge's proof; only Den's own route carries it. Remove it from the file.`,
    );
  let doc: unknown;
  try {
    doc = yaml.parse(text);
  } catch {
    return;
  }
  const http = (doc as { http?: unknown } | null)?.http;
  if (!http || typeof http !== "object") return;
  for (const sec of NAMED_SECTIONS) {
    const names = (http as Record<string, unknown>)[sec];
    if (!names || typeof names !== "object") continue;
    for (const n of Object.keys(names))
      if (reserved.has(`${sec}.${n}`) || /^den-/i.test(n))
        throw new Error(
          `edge.include: ${f} defines http.${sec}.${n}, a name Den's own config uses; Den's definition must be the only one. Rename it.`,
        );
  }
}

/**
 * Copy the included files beside the generated one, then drop copies whose
 * source is gone. Only files a previous sync copied in (its ledger) are ever
 * removed: stacks write their own route files (stack-*.yml) into the same
 * directory, and those belong to the running stacks. New files land before
 * stale ones go, so the watching Traefik never sees a gap.
 */
export function syncIncluded(cfg: EdgeConfig): string[] {
  const dyn = path.join(cfg.stateDir, "dynamic");
  const files = includeFiles(cfg.include).filter((f) => !isOwnedElsewhere(f));
  // Nothing included may stand in for what Den renders, checked before
  // anything is copied.
  const reserved = denDynamicNames(cfg);
  for (const f of files) assertIncludeAllowed(cfg.include!, f, reserved);
  fs.mkdirSync(dyn, { recursive: true });
  for (const f of files)
    fs.copyFileSync(path.join(cfg.include!, f), path.join(dyn, f));
  for (const f of readLedger(cfg.stateDir))
    if (!files.includes(f) && !isOwnedElsewhere(f) && !f.includes("/"))
      fs.rmSync(path.join(dyn, f), { force: true });
  writeFileAtomic(
    path.join(cfg.stateDir, INCLUDED_LEDGER),
    JSON.stringify(files, null, 2) + "\n",
  );
  return files;
}

// ── Edge ─────────────────────────────────────────────────────────────────────

/** Where the dynamic config mounts in the edge container (render.ts). */
const DYNAMIC_TARGET = "/etc/edge/dynamic";

/** An existing container of the edge's name: who owns it, as it says. */
export interface ExistingEdge {
  /** Its `den.edge.root` label, or null for an unlabelled (legacy) edge. */
  root: string | null;
  /** The dir its dynamic-config mount comes from, when it has one. */
  mountsDir: string | null;
}

/** The container named `name`, any state; null when there is none. */
export function existingEdge(name: string): ExistingEdge | null {
  const r = sh("docker", [
    "inspect",
    "--type",
    "container",
    "-f",
    `{{index .Config.Labels "${EDGE_ROOT_LABEL}"}}|{{range .Mounts}}{{.Source}}>{{.Destination}};{{end}}`,
    name,
  ]);
  // A container always prints the separator; nothing at all is no answer.
  if (r.code !== 0 || !r.out.includes("|")) return null;
  const [label, mounts] = r.out.split("|");
  const root = label && label !== "<no value>" ? label : null;
  let mountsDir: string | null = null;
  for (const m of (mounts ?? "").split(";")) {
    const [src, dst] = m.split(">");
    if (src && dst === DYNAMIC_TARGET) mountsDir = path.dirname(src);
  }
  return { root, mountsDir };
}

function realOrSelf(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * Whether this invocation may create, recreate or stop the edge
 * (0.3.0-dev.40, P1: a scratch root with its own DEN_EDGE_DIR but the real
 * edge.org recreated the user's real edge with the scratch certs and
 * routes; the container and project are named by org). An existing edge is
 * ours only when its `den.edge.root` label is this state dir; an
 * unlabelled (legacy) one is adopted only from the default state dir, never
 * under a DEN_EDGE_DIR that overrides it. `takeOver` (`edge up
 * --take-over`) is the only override. Nothing is touched; only paths are
 * said.
 */
export function assertEdgeOwnedHere(
  cfg: EdgeConfig,
  opts: {
    takeOver?: boolean;
    warn?: (line: string) => void;
    /** What a refusal says it won't do: "replacing" (up), "stopping" (down). */
    verb?: "replacing" | "stopping";
  } = {},
): void {
  const n = edgeNames(cfg.org);
  const found = existingEdge(n.container);
  if (!found) return;
  const here = realOrSelf(cfg.stateDir);
  const ours = found.root
    ? realOrSelf(found.root) === here
    : !cfg.defaultStateDir; // legacy: only from the default state dir
  if (ours) return;
  const other = found.root ?? found.mountsDir ?? "another state dir";
  const warn = opts.warn ?? ((l: string) => console.warn(l));
  // A scratch root on the real org: the name is the org's, so only another
  // org isolates it.
  if (cfg.defaultStateDir)
    warn(
      `Warning: DEN_EDGE_DIR (${cfg.stateDir}) is not this config's edge dir, ` +
        `and edge.org "${cfg.org}" names an edge that exists already. ` +
        `Give this root a distinct edge.org.`,
    );
  if (opts.takeOver) {
    warn(`Taking over edge ${n.container} from ${other} (--take-over).`);
    return;
  }
  throw new Error(
    `edge ${n.container} belongs to ${other}; not ${opts.verb ?? "replacing"} it`,
  );
}

/** The edge container as `docker inspect` gives it, or null (#385). */
export function inspectEdge(name: string): RunningEdge | null {
  const r = sh("docker", ["inspect", "--type", "container", name]);
  return r.code === 0 ? parseEdgeInspect(r.out) : null;
}

/** The id the image reference resolves to here, or null (not pulled). */
function localImageId(ref: string): string | null {
  const r = sh("docker", ["image", "inspect", "-f", "{{.Id}}", ref]);
  return r.code === 0 && r.out ? r.out : null;
}

/**
 * What `edge up` says before it writes compose.yml (SEC-2a): the `edge.args`
 * it drops (Den owns the entrypoints' trust), and, when the running edge's
 * command differs from the new one, that it recreates the edge once and
 * why. Pure: `running` is the running container's command, or null.
 * edgeUp passes null: its #385 line (spec.ts) names every field that
 * changed, the command's flags among them.
 */
export function edgeUpNotices(
  cfg: EdgeConfig,
  running: readonly string[] | null,
): string[] {
  const out: string[] = [];
  const dropped = droppedEdgeArgs(cfg);
  if (dropped.length)
    out.push(
      `edge.args: ignoring ${dropped.join(", ")}: Den sets the entrypoints' ` +
        "forwarded-header trust itself (its own networks and loopback), and " +
        "PROXY protocol trust from edge.proxy_protocol.trusted_ips. Remove it " +
        "from the config to silence this.",
    );
  const noTrace = accessLogNoTraceNotice(cfg);
  if (noTrace) out.push(noTrace);
  const drift = edgeCommandDrift(running, edgeCommand(cfg));
  if (drift.length)
    out.push(
      `${edgeNames(cfg.org).container}'s settings changed (${drift.join(", ")}): ` +
        "recreating it once. Routes drop only while it restarts.",
    );
  return out;
}

/** What edgeUp's port check needs; each part has a default (tests swap them). */
export interface EdgePortCheck {
  /** The identity key (identityKey(web.secret)); null: nothing proves. */
  key?: Buffer | null;
  /** Den's web port here. */
  webPort?: number;
  probe?: typeof probeIdentity;
  owner?: (port: number) => PortOwner | null;
  inUse?: (port: number) => Promise<boolean>;
  state?: (container: string) => string;
  log?: (line: string) => void;
}

function heldText(port: number, o: PortOwner | null, title: string): string {
  const lang = cliLanguage();
  return o
    ? addressWord(lang, "edgeHeld", {
        port,
        owner: o.owner,
        kind: addressWord(
          lang,
          o.kind === "container" ? "kind.container" : "kind.process",
        ),
        name: o.name,
        title,
      })
    : addressWord(lang, "edgeHeldUnknown", { port, title });
}

/**
 * Issue 455: the edge's host ports, on every `up`. The edge down: each
 * port must be free in every address family (port-pick.ts), and what
 * holds one is named. The edge running: its http port must answer as
 * this Den through Den's own route (the identity probe); when something
 * else answers, and it isn't this edge's container, `up` stops and says
 * what answered. With Den's web server not answering, nothing can be
 * proven: that is said, and `up` goes on.
 */
export async function assertEdgePorts(
  cfg: EdgeConfig,
  c: EdgePortCheck = {},
): Promise<void> {
  if (!cfg.ports) return;
  const n = edgeNames(cfg.org);
  const title = product().title;
  const owner = c.owner ?? portOwner;
  const inUse = c.inUse ?? portInUse;
  const running = (c.state ?? containerState)(n.container) === "running";
  if (!running) {
    for (const p of [cfg.ports.http, cfg.ports.https])
      if (await inUse(p))
        throw new Error(
          `${heldText(p, owner(p), title)} ` +
            `port ${p} is already in use. Free it, pick other ports ` +
            `(edge.http_port / edge.https_port in config/local/user.yml), or ` +
            `set edge.publish: false if another proxy forwards to ${n.container}.`,
        );
    return;
  }
  const webPort = c.webPort ?? readWebPort();
  const key = c.key === undefined ? localIdentityKey(getStateDir()) : c.key;
  const host = webRouteHosts(cfg, new Set([webPort]))[0]?.host;
  if (!key || !host) return;
  const probe = c.probe ?? probeIdentity;
  const s = addressCheckSettings();
  const opts = { key, timeoutMs: s.timeoutMs, retries: s.retries };
  const lang = cliLanguage();
  const own = await probe(localhostOrigin(webPort), opts);
  if (!own.ok) {
    (c.log ?? ((l: string) => console.log(l)))(
      addressWord(lang, "doctor.unchecked", { title }),
    );
    return;
  }
  const p = cfg.ports.http;
  const via = await probe(`http://${host}${p === 80 ? "" : `:${p}`}`, opts);
  if (via.ok || !via.other) return;
  const o = owner(p);
  // This edge's own container answering (its route not written yet): up
  // writes it.
  if (o?.kind === "container" && o.name === n.container) return;
  throw new Error(
    addressWord(lang, "edgeNotDen", {
      port: p,
      title,
      what: o
        ? `${o.owner} (${addressWord(lang, o.kind === "container" ? "kind.container" : "kind.process")} ${o.name})`
        : (serverName(via.other.server) ?? `HTTP ${via.other.status}`),
    }),
  );
}

export async function edgeUp(
  cfg: EdgeConfig,
  opts: {
    takeOver?: boolean;
    log?: (line: string) => void;
    /** H1: a new edge proof; the old one stops working at once. */
    rotateProof?: boolean;
    /** Issue 455: the port check's parts (tests). */
    check?: EdgePortCheck;
  } = {},
) {
  // Before anything is written or started: an edge of this name that
  // another state dir owns is never replaced.
  assertEdgeOwnedHere(cfg, opts);
  const n = edgeNames(cfg.org);
  // Issue 455: on every up, not only when the edge is down.
  if (cfg.ports) await assertEdgePorts(cfg, opts.check);
  assertCaUsable(cfg);
  warnImplicitTlsOnce(cfg);
  ensureNetwork(n.network);
  for (const net of [
    ...(cfg.dockerLabels ? [cfg.dockerLabels.network] : []),
    ...cfg.networks,
  ])
    if (sh("docker", ["network", "inspect", net]).code !== 0)
      throw new Error(
        `Docker network ${net} does not exist; the edge joins it but never creates it.`,
      );
  for (const host of Object.keys(cfg.mounts))
    if (!fs.existsSync(host))
      throw new Error(`edge.mounts: ${host} does not exist on this machine`);
  const certs = ensureCerts(cfg);
  const included = syncIncluded(cfg);
  // #63: Den makes the raw access file (0600) so Traefik never does.
  if (cfg.accessLog?.enabled) prepareAccessRaw(cfg.stateDir);
  // An edge running with Traefik's API on would show the proof about to be
  // written: stop it first, and make a new proof, so one it may have shown
  // never works again.
  const running = inspectEdge(n.container);
  const servedApi =
    !!running?.running && commandServesApi(running.spec.command);
  if (servedApi) must("docker", ["stop", n.container]);
  // H1: the proof Den's own route carries (made once, or a new one).
  const proof =
    opts.rotateProof || servedApi
      ? rotateEdgeProof(cfg.stateDir)
      : ensureEdgeProof(cfg.stateDir);
  writeEdgeDynamic(
    cfg.stateDir,
    renderEdgeDynamic(cfg, { proof, ports: new Set([readWebPort()]) }),
  );
  const compose = path.join(cfg.stateDir, "compose.yml");
  // SEC-2a: say what changed before compose recreates the edge for it.
  const log = opts.log ?? ((l: string) => console.log(l));
  // #385: the running container's spec against the one rendered now
  // (image, ports, command flags, mounts, networks), said before compose
  // recreates it, and what happened after.
  const root = realOrSelf(cfg.stateDir);
  const before = inspectEdge(n.container);
  const changes = before
    ? edgeSpecChanges(
        before.spec,
        renderedEdgeSpec(cfg, root, localImageId(cfg.image)),
        realOrSelf,
      )
    : [];
  for (const line of edgeUpNotices(cfg, null)) log(line);
  if (before?.running && changes.length)
    log(
      `Recreating ${n.container} because ${edgeChangesText(changes)}: ` +
        "routes drop while it restarts.",
    );
  write(compose, renderEdgeCompose(cfg, root));
  const began = Date.now();
  must("docker", ["compose", "-f", compose, "up", "-d", "--remove-orphans"]);
  const outcome: EdgeUpOutcome = edgeUpOutcome(
    before,
    inspectEdge(n.container),
    changes,
    { began, ended: Date.now() },
  );
  log(edgeUpLine(outcome));
  // Up as rendered (no API): any hold on the edge's trust ends.
  releaseEdgeTrust(cfg.stateDir);
  return { certs, included, outcome };
}

export function edgeDown(cfg: EdgeConfig): void {
  // The project is named by org too: another dir's edge is not ours to stop.
  assertEdgeOwnedHere(cfg, { verb: "stopping" });
  const compose = path.join(cfg.stateDir, "compose.yml");
  if (fs.existsSync(compose))
    must("docker", ["compose", "-f", compose, "down"]);
}
