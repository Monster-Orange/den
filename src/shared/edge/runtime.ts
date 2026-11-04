/**
 * Side effects for the edge: docker, mkcert, files. Thin on purpose — every
 * routing decision lives in render.ts.
 */
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as net from "net";
import * as path from "path";
import {
  certNames,
  edgeNames,
  renderEdgeCompose,
  renderEdgeDynamic,
} from "./render.js";
import type { EdgeConfig } from "./types.js";

function sh(
  cmd: string,
  args: string[],
  opts: { env?: NodeJS.ProcessEnv; inherit?: boolean } = {},
) {
  const r = spawnSync(cmd, args, {
    encoding: "utf-8",
    env: { ...process.env, ...opts.env },
    stdio: opts.inherit ? "inherit" : "pipe",
  });
  if (r.error) throw new Error(`${cmd} is not installed (${r.error.message})`);
  return {
    code: r.status ?? 1,
    out: (r.stdout ?? "").trim(),
    err: (r.stderr ?? "").trim(),
  };
}

function must(
  cmd: string,
  args: string[],
  opts: { env?: NodeJS.ProcessEnv } = {},
): string {
  const r = sh(cmd, args, opts);
  if (r.code !== 0)
    throw new Error(`${cmd} ${args.join(" ")} failed:\n${r.err || r.out}`);
  return r.out;
}

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

// ── Certificates (org-scoped CA) ─────────────────────────────────────────────

export function caDir(cfg: EdgeConfig): string {
  return cfg.caroot ?? path.join(cfg.stateDir, "ca");
}

/** True when the edge uses an existing CA (`caroot`) rather than its own. */
export function sharedCa(cfg: EdgeConfig): boolean {
  return cfg.caroot !== null;
}

/**
 * A shared CA must already exist with its key: mkcert silently creates a new
 * CA in an empty CAROOT, and devices that trust the shared one would not
 * trust that. The org's own CA may be created on first use.
 */
export function assertCaUsable(cfg: EdgeConfig): void {
  if (!sharedCa(cfg)) return;
  const dir = caDir(cfg);
  if (!fs.existsSync(dir))
    throw new Error(
      `edge.caroot ${dir} does not exist. The edge never creates a CA there; ` +
        `point caroot at the existing CA (\`mkcert -CAROOT\`).`,
    );
  for (const f of ["rootCA.pem", "rootCA-key.pem"])
    if (!fs.existsSync(path.join(dir, f)))
      throw new Error(
        `edge.caroot ${dir} has no ${f}. Refusing to run: mkcert would mint a ` +
          `new CA that other devices don't trust.`,
      );
}

function mkcertEnv(cfg: EdgeConfig): NodeJS.ProcessEnv {
  return { CAROOT: caDir(cfg) };
}

/** Issue (or re-issue when names changed) the edge cert from the org's own CA. */
export function ensureCerts(cfg: EdgeConfig): {
  issued: boolean;
  names: string[];
} {
  const names = certNames(cfg);
  if (!cfg.issueCert) return { issued: false, names: [] };
  assertCaUsable(cfg);
  const dir = path.join(cfg.stateDir, "certs");
  const stamp = path.join(dir, "names.txt");
  const want = names.join("\n");
  if (
    fs.existsSync(path.join(dir, "edge.pem")) &&
    fs.existsSync(stamp) &&
    fs.readFileSync(stamp, "utf-8") === want
  )
    return { issued: false, names };
  fs.mkdirSync(dir, { recursive: true });
  if (!sharedCa(cfg))
    fs.mkdirSync(caDir(cfg), { recursive: true, mode: 0o700 });
  must(
    "mkcert",
    [
      "-cert-file",
      path.join(dir, "edge.pem"),
      "-key-file",
      path.join(dir, "edge-key.pem"),
      ...names,
    ],
    { env: mkcertEnv(cfg) },
  );
  write(stamp, want);
  return { issued: true, names };
}

/** Install the org CA into the system + browser trust stores (prompts for a password). */
export function trustCa(cfg: EdgeConfig): number {
  assertCaUsable(cfg);
  if (!sharedCa(cfg))
    fs.mkdirSync(caDir(cfg), { recursive: true, mode: 0o700 });
  return sh("mkcert", ["-install"], { env: mkcertEnv(cfg), inherit: true })
    .code;
}

export function untrustCa(cfg: EdgeConfig): number {
  if (sharedCa(cfg))
    throw new Error(
      `edge.caroot is a shared CA (${caDir(cfg)}); other tools and devices ` +
        `rely on it being trusted, so the edge never uninstalls it.`,
    );
  return sh("mkcert", ["-uninstall"], { env: mkcertEnv(cfg), inherit: true })
    .code;
}

/** Whether the org CA is in the macOS system keychain (null: can't tell). */
export function caTrusted(cfg: EdgeConfig): boolean | null {
  const pem = path.join(caDir(cfg), "rootCA.pem");
  if (!fs.existsSync(pem)) return false;
  if (process.platform !== "darwin") return null;
  return sh("security", ["verify-cert", "-c", pem]).code === 0;
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
 * Copy the included files beside the generated one, then drop copies whose
 * source is gone. New files land before stale ones go, so the watching
 * Traefik never sees a gap.
 */
export function syncIncluded(cfg: EdgeConfig): string[] {
  const dyn = path.join(cfg.stateDir, "dynamic");
  fs.mkdirSync(dyn, { recursive: true });
  const files = includeFiles(cfg.include);
  for (const f of files)
    fs.copyFileSync(path.join(cfg.include!, f), path.join(dyn, f));
  for (const f of includeFiles(dyn))
    if (!files.includes(f)) fs.rmSync(path.join(dyn, f), { force: true });
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
