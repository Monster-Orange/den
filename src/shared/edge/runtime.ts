/**
 * Side effects for the edge: docker, files, and the TLS strategy's (tls.ts).
 * Thin on purpose — every routing decision lives in render.ts.
 */
import * as fs from "fs";
import * as net from "net";
import * as path from "path";
import { must, sh } from "./exec.js";
import { edgeNames, renderEdgeCompose, renderEdgeDynamic } from "./render.js";
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
import type { EdgeConfig } from "./types.js";

export { assertCaUsable, caDir, caTrusted, sharedCa };

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf-8");
}

function ensureNetwork(name: string): void {
  if (sh("docker", ["network", "inspect", name]).code !== 0)
    must("docker", ["network", "create", name]);
}

export function containerState(name: string): string {
  const r = sh("docker", ["inspect", "-f", "{{.State.Status}}", name]);
  return r.code === 0 ? r.out : "absent";
}

/** True when something on 127.0.0.1 accepts connections on `port`. */
export function portInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ host: "127.0.0.1", port });
    s.once("connect", () => (s.destroy(), resolve(true)));
    s.once("error", () => resolve(false));
    s.setTimeout(500, () => (s.destroy(), resolve(false)));
  });
}

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

const GENERATED = "edge.yml";

/** The dynamic-config files in `dir` to copy in (top level, YAML only). */
export function includeFiles(dir: string | null): string[] {
  if (!dir) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter(
      (e) => e.isFile() && /\.ya?ml$/.test(e.name) && e.name !== GENERATED,
    )
    .map((e) => e.name)
    .sort();
}

/**
 * Names the last sync copied in. Kept in the state dir, outside dynamic/,
 * so the watching Traefik never reads it.
 */
const INCLUDED_LEDGER = "included.json";

/** Files other writers own in the dynamic directory: never copied over or pruned. */
const isOwnedElsewhere = (f: string): boolean =>
  f === GENERATED || /^stack-.*\.ya?ml$/.test(f);

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

/**
 * Copy the included files beside the generated one, then drop copies whose
 * source is gone. Only files a previous sync copied in (its ledger) are ever
 * removed: stacks write their own route files (stack-*.yml) into the same
 * directory, and those belong to the running stacks. New files land before
 * stale ones go, so the watching Traefik never sees a gap.
 */
export function syncIncluded(cfg: EdgeConfig): string[] {
  const dyn = path.join(cfg.stateDir, "dynamic");
  fs.mkdirSync(dyn, { recursive: true });
  const files = includeFiles(cfg.include).filter((f) => !isOwnedElsewhere(f));
  for (const f of files)
    fs.copyFileSync(path.join(cfg.include!, f), path.join(dyn, f));
  for (const f of readLedger(cfg.stateDir))
    if (!files.includes(f) && !isOwnedElsewhere(f) && !f.includes("/"))
      fs.rmSync(path.join(dyn, f), { force: true });
  fs.writeFileSync(
    path.join(cfg.stateDir, INCLUDED_LEDGER),
    JSON.stringify(files, null, 2) + "\n",
  );
  return files;
}

// ── Edge ─────────────────────────────────────────────────────────────────────

export async function edgeUp(cfg: EdgeConfig) {
  const n = edgeNames(cfg.org);
  if (cfg.ports && containerState(n.container) !== "running") {
    for (const p of [cfg.ports.http, cfg.ports.https])
      if (await portInUse(p))
        throw new Error(
          `port ${p} is already in use. Free it, pick other ports ` +
            `(edge.http_port / edge.https_port in config/local/user.yml), or ` +
            `set edge.publish: false if another proxy forwards to ${n.container}.`,
        );
  }
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
  write(path.join(cfg.stateDir, "dynamic", GENERATED), renderEdgeDynamic(cfg));
  const compose = path.join(cfg.stateDir, "compose.yml");
  write(compose, renderEdgeCompose(cfg));
  must("docker", ["compose", "-f", compose, "up", "-d", "--remove-orphans"]);
  return { certs, included };
}

export function edgeDown(cfg: EdgeConfig): void {
  const compose = path.join(cfg.stateDir, "compose.yml");
  if (fs.existsSync(compose))
    must("docker", ["compose", "-f", compose, "down"]);
}
