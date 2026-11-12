/** Side effects for stacks: docker compose, link networks, edge routes. */
import { createHash, randomBytes } from "crypto";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { getReposRoot } from "../den-config.js";
import { getStateDir } from "../paths.js";
import { product } from "../product.js";
import { edgeNames } from "../edge/render.js";
import type { EdgeConfig } from "../edge/types.js";
import {
  containerName,
  DEN_OWNER_LABEL,
  expandEnv,
  linkNetwork,
  projectName,
  providerServices,
  renderOverride,
  renderStackRoutes,
  routedNetworks,
} from "./render.js";
import {
  resolveSecretEnv,
  secretEnvKeys,
  type SecretEnvResolution,
} from "../secrets/secret-env.js";
import type { SecretsProvider } from "../secrets/types.js";
import type { ResolvedProject, StackConfig } from "./types.js";

function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; inherit?: boolean } = {},
) {
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd,
    encoding: "utf-8",
    env: { ...process.env, ...opts.env },
    stdio: opts.inherit ? "inherit" : "pipe",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error) throw new Error(`${cmd}: ${r.error.message}`);
  return {
    code: r.status ?? 1,
    out: (r.stdout ?? "").trim(),
    err: (r.stderr ?? "").trim(),
  };
}

function must(
  cmd: string,
  args: string[],
  opts: Parameters<typeof run>[2] = {},
): string {
  const r = run(cmd, args, opts);
  if (r.code !== 0)
    throw new Error(
      `${cmd} ${args.slice(0, 6).join(" ")}… failed:\n${r.err || r.out}`,
    );
  return r.out;
}

export interface StackContext {
  edge: EdgeConfig;
  stacks: Record<string, StackConfig>;
  /** The Compose project suffix (the stack namespace). */
  workspace: string;
  /** The den workspace the stacks were read for (loadStackContext). */
  denWorkspace?: string;
  /** Where the suffix came from; `env`: DEN_STACK_WORKSPACE. */
  namespaceSource?: "workspace" | "blueprint" | "default" | "env";
}

/** The project's local state: generated.env, override.yml, owners.json. */
export function stackDir(ctx: StackContext, s: StackConfig): string {
  return path.join(
    ctx.edge.stateDir,
    "stacks",
    projectName(s.name, ctx.workspace),
  );
}

/**
 * D53: the label Den puts on every container of a stack it starts, and
 * the value that marks this install's stack. A Compose project's name is
 * only a name: a repo's manifest can name one that something else runs
 * (another tool's, or another install's). Den acts only on containers
 * carrying its own mark for that stack and checkout.
 */
export { DEN_OWNER_LABEL };

/** This install's mark for stack `s` in its project: install, stack, checkout. */
export function stackOwner(ctx: StackContext, s: StackConfig): string {
  const checkout = path.resolve(
    s.repoPath ?? path.join(getReposRoot(), s.repo),
    s.dir ?? "",
  );
  return createHash("sha256")
    .update(
      [
        getStateDir(),
        projectName(s.name, ctx.workspace),
        s.name,
        checkout,
      ].join("\0"),
    )
    .digest("hex")
    .slice(0, 16);
}

/** Who runs a stack's Compose project now (see projectOwnership). */
export interface ProjectOwnership {
  project: string;
  /** Containers in the project that aren't this stack's: their names. */
  foreign: string[];
  /** Containers that are. */
  ours: number;
  /** False when docker couldn't be asked. */
  known: boolean;
}

/**
 * The containers of `s`'s project, sorted into this stack's and anything
 * else's. Ours: Den's owner label with this stack's mark; or, for a
 * container Den started before the label (0.4.34 and older), Compose's
 * own record of its files naming this stack's override and compose file.
 */
export function projectOwnership(
  ctx: StackContext,
  s: StackConfig,
): ProjectOwnership {
  const project = projectName(s.name, ctx.workspace);
  let r: ReturnType<typeof run>;
  try {
    r = run("docker", [
      "ps",
      "-a",
      "--filter",
      `label=com.docker.compose.project=${project}`,
      "--format",
      `{{.Names}}\t{{.Label "${DEN_OWNER_LABEL}"}}\t{{.Label "com.docker.compose.project.config_files"}}`,
    ]);
  } catch {
    return { project, foreign: [], ours: 0, known: false };
  }
  if (r.code !== 0) return { project, foreign: [], ours: 0, known: false };
  const mine = stackOwner(ctx, s);
  const override = path.join(stackDir(ctx, s), "override.yml");
  const base = path.resolve(
    s.repoPath ?? path.join(getReposRoot(), s.repo),
    s.dir ?? "",
    s.files[0] ?? "docker-compose.yml",
  );
  const foreign: string[] = [];
  let ours = 0;
  for (const line of r.out.split("\n").filter(Boolean)) {
    const [name = "", label = "", files = ""] = line.split("\t");
    const list = files.split(",").map((f) => f.trim());
    const isOurs = label
      ? label === mine
      : list.includes(override) && list.includes(base);
    if (isOurs) ours++;
    else foreign.push(name);
  }
  return { project, foreign, ours, known: true };
}

/**
 * D53: refuse to act on a project with containers this stack didn't
 * start: `up`, `down` and `restart` would otherwise stop, replace or
 * restart them.
 */
export function assertStackOwned(
  ctx: StackContext,
  s: StackConfig,
  verb: "up" | "down" | "restart",
): void {
  const o = projectOwnership(ctx, s);
  if (!o.foreign.length) return;
  const shown = o.foreign.slice(0, 5).join(", ");
  const more = o.foreign.length > 5 ? ` and ${o.foreign.length - 5} more` : "";
  throw new Error(
    `stack ${s.name}: Compose project "${o.project}" has containers ${product().cli} ` +
      `didn't start for this stack (${shown}${more}). \`stack ${verb}\` is refused: it ` +
      `would act on them. Give the stack a project of its own (compose.name in ` +
      `the repo's .den.yml), or stop that project yourself.`,
  );
}

export function repoDir(s: StackConfig): string {
  const dir = path.join(
    s.repoPath ?? path.join(getReposRoot(), s.repo),
    s.dir ?? "",
  );
  if (!fs.existsSync(dir))
    throw new Error(
      `stack ${s.name}: ${dir} does not exist (clone ${s.repo} first)`,
    );
  return dir;
}

/** Generated local-only secrets, created once per stack + workspace. */
function generatedEnv(
  ctx: StackContext,
  s: StackConfig,
): Record<string, string> {
  const file = path.join(stackDir(ctx, s), "generated.env");
  const have: Record<string, string> = {};
  if (fs.existsSync(file))
    for (const line of fs.readFileSync(file, "utf-8").split("\n")) {
      const i = line.indexOf("=");
      if (i > 0) have[line.slice(0, i)] = line.slice(i + 1);
    }
  let changed = false;
  for (const k of s.generate)
    if (!have[k]) {
      have[k] = randomBytes(32).toString("base64url");
      changed = true;
    }
  if (changed) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      file,
      Object.entries(have)
        .map(([k, v]) => `${k}=${v}`)
        .join("\n") + "\n",
      { mode: 0o600 },
    );
  }
  return have;
}

function composeEnv(ctx: StackContext, s: StackConfig): NodeJS.ProcessEnv {
  return {
    ...generatedEnv(ctx, s),
    ...expandEnv(s.env, ctx.workspace, ctx.stacks),
    COMPOSE_PROJECT_NAME: projectName(s.name, ctx.workspace),
    ...(s.profiles.length ? { COMPOSE_PROFILES: s.profiles.join(",") } : {}),
  };
}

/**
 * Resolve a stack's `secret_env` through `provider` (all or nothing). Call
 * it before anything starts or stops, and hand the env to stackUp /
 * stackRestartService. Nothing in the result's message carries a value.
 */
export function resolveStackSecretEnv(
  s: StackConfig,
  provider: SecretsProvider,
): Promise<SecretEnvResolution> {
  return resolveSecretEnv(s.secretEnv, provider, `stack ${s.name}`);
}

/**
 * The resolved secrets for a compose process that starts containers. Fails
 * closed: a stack that declares `secret_env` is never started without every
 * key (that is how a plain restart used to drop one).
 */
function secretComposeEnv(
  s: StackConfig,
  secretEnv: Record<string, string> | undefined,
): Record<string, string> {
  const missing = secretEnvKeys(s.secretEnv).filter((k) => !secretEnv?.[k]);
  if (missing.length)
    throw new Error(
      `stack ${s.name}: secret_env ${missing.join(", ")} not resolved; not starting it`,
    );
  return secretEnv ?? {};
}

function baseArgs(ctx: StackContext, s: StackConfig): string[] {
  return [
    "compose",
    "-p",
    projectName(s.name, ctx.workspace),
    ...s.files.flatMap((f) => ["-f", f]),
  ];
}

function resolve(ctx: StackContext, s: StackConfig): ResolvedProject {
  const out = must(
    "docker",
    [...baseArgs(ctx, s), "config", "--format", "json"],
    {
      cwd: repoDir(s),
      env: composeEnv(ctx, s),
    },
  );
  return JSON.parse(out) as ResolvedProject;
}

function overrideArgs(ctx: StackContext, s: StackConfig): string[] {
  return [
    ...baseArgs(ctx, s),
    "-f",
    path.join(stackDir(ctx, s), "override.yml"),
  ];
}

function ensureNetwork(name: string): void {
  if (run("docker", ["network", "inspect", name]).code !== 0)
    must("docker", ["network", "create", name]);
}

/** `docker network connect`, ignoring "already connected". Container-name alias only. */
function connect(network: string, container: string): void {
  const r = run("docker", ["network", "connect", network, container]);
  if (r.code !== 0 && !/already exists|already connected/i.test(r.err))
    throw new Error(`docker network connect ${network} ${container}: ${r.err}`);
}

/**
 * Connect the edge to each of `nets` it is not on (`on`: the networks it
 * is on already; unknown, every one is connected, "already connected"
 * being fine). Returns the networks it joined. stack up and the rejoin
 * after edge up share it.
 */
function joinEdge(
  edge: EdgeConfig,
  nets: string[],
  on: ReadonlySet<string> = new Set(),
): string[] {
  const container = edgeNames(edge.org).container;
  const joined: string[] = [];
  for (const n of nets) {
    if (on.has(n)) continue;
    connect(n, container);
    joined.push(n);
  }
  return joined;
}

/** The dynamic file a running stack's routes live in, under this edge's state dir. */
function stackRoutesFile(edge: EdgeConfig, project: string): string {
  return path.join(edge.stateDir, "dynamic", `stack-${project}.yml`);
}

/**
 * After edge up (re)creates or starts the edge, put it back on every
 * running stack's routed networks (0.3.0-dev.40): a recreated container
 * starts on its own network only, and each stack's routes 502 until that
 * stack's next `stack up`. A stack counts when it has its routes file in
 * this edge's dynamic dir and its compose project has a container up;
 * stacks that are down, and projects with no routes file here (another
 * state dir's, or none of Den's), are not touched. Idempotent: a network
 * the edge is on already is left alone. One line per network joined;
 * a stack that cannot be resolved gets a line and is skipped.
 */
export function rejoinEdgeNetworks(
  contexts: StackContext[],
  onLine: (line: string) => void = console.log,
): string[] {
  if (!contexts.length) return [];
  const edge = contexts[0].edge;
  const on = new Set(
    run("docker", [
      "inspect",
      "-f",
      "{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}",
      edgeNames(edge.org).container,
    ]).out.split(/\s+/),
  );
  const joined: string[] = [];
  const seen = new Set<string>();
  for (const ctx of contexts) {
    // Only this edge's state dir.
    if (ctx.edge.stateDir !== edge.stateDir) continue;
    for (const s of Object.values(ctx.stacks)) {
      const project = projectName(s.name, ctx.workspace);
      if (seen.has(project)) continue;
      seen.add(project);
      if (!fs.existsSync(stackRoutesFile(edge, project))) continue;
      const up = run("docker", [
        "ps",
        "-q",
        "--filter",
        `label=com.docker.compose.project=${project}`,
      ]);
      if (up.code !== 0 || !up.out) continue;
      try {
        for (const n of joinEdge(
          edge,
          routedNetworks(s, resolve(ctx, s)),
          on,
        )) {
          on.add(n);
          joined.push(n);
          onLine(`  rejoined ${n} (${project})`);
        }
      } catch (err) {
        onLine(
          `  ${project}: not rejoined (${(err as Error).message.split("\n")[0]})`,
        );
      }
    }
  }
  return joined;
}

function running(container: string): boolean {
  return (
    run("docker", ["inspect", "-f", "{{.State.Running}}", container]).out ===
    "true"
  );
}

export function stackUp(
  ctx: StackContext,
  s: StackConfig,
  opts: {
    build?: boolean;
    /** The stack's resolved `secret_env` (see resolveStackSecretEnv). */
    secretEnv?: Record<string, string>;
  } = {},
) {
  const secrets = secretComposeEnv(s, opts.secretEnv);
  // `compose config` runs without them: its JSON (which feeds the override)
  // must not carry a secret.
  const resolved = resolve(ctx, s);
  // Provider side of each link: its referenced services join a private network.
  const needs = providerServices(s);
  for (const p of s.uses) {
    const net = linkNetwork(s.name, p, ctx.workspace);
    ensureNetwork(net);
    for (const svc of needs[p] ?? []) {
      const c = containerName(projectName(p, ctx.workspace), svc);
      if (!running(c))
        throw new Error(
          `stack ${s.name} needs ${p}'s ${svc} (${c}), which is not running`,
        );
      connect(net, c);
    }
  }
  assertStackOwned(ctx, s, "up");
  const dir = stackDir(ctx, s);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "override.yml"),
    renderOverride(s, resolved, ctx.workspace, stackOwner(ctx, s)),
  );
  must(
    "docker",
    [
      ...overrideArgs(ctx, s),
      "up",
      "-d",
      ...(opts.build ? ["--build"] : []),
      "--remove-orphans",
    ],
    {
      cwd: repoDir(s),
      env: { ...composeEnv(ctx, s), ...secrets },
      inherit: true,
    },
  );
  // This stack as a provider: consumers already running keep their link
  // network, but a restarted provider's new containers must rejoin it.
  for (const c of Object.values(ctx.stacks)) {
    if (!c.uses.includes(s.name)) continue;
    const net = linkNetwork(c.name, s.name, ctx.workspace);
    if (run("docker", ["network", "inspect", net]).code !== 0) continue;
    for (const svc of providerServices(c)[s.name] ?? [])
      connect(net, containerName(projectName(s.name, ctx.workspace), svc));
  }
  const nets = routedNetworks(s, resolved);
  joinEdge(ctx.edge, nets);
  fs.writeFileSync(
    stackRoutesFile(ctx.edge, projectName(s.name, ctx.workspace)),
    renderStackRoutes(ctx.edge, s, resolved),
  );
  return { project: resolved.name, networks: nets };
}

export function stackDown(ctx: StackContext, s: StackConfig): void {
  assertStackOwned(ctx, s, "down");
  fs.rmSync(stackRoutesFile(ctx.edge, projectName(s.name, ctx.workspace)), {
    force: true,
  });
  const edge = edgeNames(ctx.edge.org).container;
  const dir = repoDir(s);
  const override = path.join(stackDir(ctx, s), "override.yml");
  const args = fs.existsSync(override)
    ? overrideArgs(ctx, s)
    : baseArgs(ctx, s);
  // The edge holds a connection to the project network; let go so `down` can remove it.
  try {
    for (const n of routedNetworks(s, resolve(ctx, s)))
      run("docker", ["network", "disconnect", n, edge]);
  } catch {
    /* compose config failed — nothing to disconnect */
  }
  must("docker", [...args, "down"], {
    cwd: dir,
    env: composeEnv(ctx, s),
    inherit: true,
  });
  const needs = providerServices(s);
  for (const p of s.uses) {
    const net = linkNetwork(s.name, p, ctx.workspace);
    for (const svc of needs[p] ?? [])
      run("docker", [
        "network",
        "disconnect",
        net,
        containerName(projectName(p, ctx.workspace), svc),
      ]);
    run("docker", ["network", "rm", net]);
  }
}

/**
 * Restart one compose service of a running stack in place (`docker compose
 * restart`): the same container, so the same env; nothing is recreated.
 */
export function stackRestartService(
  ctx: StackContext,
  s: StackConfig,
  service: string,
  opts: { secretEnv?: Record<string, string> } = {},
): void {
  assertStackOwned(ctx, s, "restart");
  const secrets = secretComposeEnv(s, opts.secretEnv);
  const override = path.join(stackDir(ctx, s), "override.yml");
  const args = fs.existsSync(override)
    ? overrideArgs(ctx, s)
    : baseArgs(ctx, s);
  must("docker", [...args, "restart", service], {
    cwd: repoDir(s),
    env: { ...composeEnv(ctx, s), ...secrets },
    inherit: true,
  });
}

export function stackPs(ctx: StackContext, s: StackConfig): string {
  return run(
    "docker",
    [
      ...baseArgs(ctx, s),
      "ps",
      "--format",
      "table {{.Service}}\t{{.State}}\t{{.Status}}",
    ],
    {
      cwd: repoDir(s),
      env: composeEnv(ctx, s),
    },
  ).out;
}

export function stackLogs(
  ctx: StackContext,
  s: StackConfig,
  args: string[],
): number {
  return run("docker", [...baseArgs(ctx, s), "logs", ...args], {
    cwd: repoDir(s),
    env: composeEnv(ctx, s),
    inherit: true,
  }).code;
}

/**
 * Health of a running stack: ok when it has containers, all are running, and
 * none reports a failing or pending Docker healthcheck. `ok: null` when
 * docker could not be asked: container state unknown is not "not running".
 */
export function stackHealth(
  ctx: StackContext,
  s: StackConfig,
  service?: string,
): { ok: boolean | null; detail: string } {
  const project = projectName(s.name, ctx.workspace);
  let r: ReturnType<typeof run>;
  try {
    r = run("docker", [
      "ps",
      "-a",
      "--filter",
      `label=com.docker.compose.project=${project}`,
      ...(service
        ? ["--filter", `label=com.docker.compose.service=${service}`]
        : []),
      "--format",
      '{{.Label "com.docker.compose.service"}}\t{{.State}}\t{{.Status}}',
    ]);
  } catch (e) {
    return {
      ok: null,
      detail: `container state unknown: ${(e as Error).message}`,
    };
  }
  if (r.code !== 0)
    return {
      ok: null,
      detail: `container state unknown: ${r.err.trim() || "docker ps failed"}`,
    };
  const rows = r.out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [svc = "", state = "", status = ""] = line.split("\t");
      return { project, service: svc, state, status };
    });
  return judgeStackRows(rows, project, service);
}

/** One compose container, as a `docker ps` listing reports it. */
export interface ComposeRow {
  project: string;
  service: string;
  state: string;
  status: string;
  /** The container's name(s), comma-separated as docker lists them. */
  name?: string;
}

/**
 * The verdict `stack health` gives for `project` (and `service`): ok when it
 * has containers, all running, none with a failing or starting Docker
 * healthcheck. Shared by the CLI and the in-process check (compose-health).
 */
export function judgeStackRows(
  rows: ComposeRow[],
  project: string,
  service?: string,
): { ok: boolean; detail: string } {
  const mine = rows.filter(
    (r) => r.project === project && (!service || r.service === service),
  );
  if (!mine.length)
    return {
      ok: false,
      detail: `${project}${service ? `/${service}` : ""}: not running`,
    };
  const bad = mine.filter(
    (r) =>
      r.state !== "running" ||
      /\((unhealthy|health: starting)\)/.test(r.status),
  );
  return bad.length
    ? {
        ok: false,
        detail: bad
          .map((r) => `${r.service}\t${r.state}\t${r.status}`)
          .join("; "),
      }
    : { ok: true, detail: `${mine.length} container(s) running` };
}
