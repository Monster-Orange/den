/** Side effects for stacks: docker compose, link networks, edge routes. */
import { randomBytes } from "crypto";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { getReposRoot } from "../den-config.js";
import { edgeNames } from "../edge/render.js";
import type { EdgeConfig } from "../edge/types.js";
import {
  containerName,
  expandEnv,
  linkNetwork,
  projectName,
  providerServices,
  renderOverride,
  renderStackRoutes,
  routedNetworks,
} from "./render.js";
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
  workspace: string;
}

function stackDir(ctx: StackContext, s: StackConfig): string {
  return path.join(
    ctx.edge.stateDir,
    "stacks",
    projectName(s.name, ctx.workspace),
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

function running(container: string): boolean {
  return (
    run("docker", ["inspect", "-f", "{{.State.Running}}", container]).out ===
    "true"
  );
}

export function stackUp(
  ctx: StackContext,
  s: StackConfig,
  opts: { build?: boolean } = {},
) {
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
  const dir = stackDir(ctx, s);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "override.yml"),
    renderOverride(s, resolved, ctx.workspace),
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
    { cwd: repoDir(s), env: composeEnv(ctx, s), inherit: true },
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
  const edge = edgeNames(ctx.edge.org).container;
  const nets = routedNetworks(s, resolved);
  for (const n of nets) connect(n, edge);
  fs.writeFileSync(
    path.join(
      ctx.edge.stateDir,
      "dynamic",
      `stack-${projectName(s.name, ctx.workspace)}.yml`,
    ),
    renderStackRoutes(ctx.edge, s, resolved),
  );
  return { project: resolved.name, networks: nets };
}

export function stackDown(ctx: StackContext, s: StackConfig): void {
  fs.rmSync(
    path.join(
      ctx.edge.stateDir,
      "dynamic",
      `stack-${projectName(s.name, ctx.workspace)}.yml`,
    ),
    { force: true },
  );
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
 * none reports a failing or pending Docker healthcheck.
 */
export function stackHealth(
  ctx: StackContext,
  s: StackConfig,
  service?: string,
): { ok: boolean; detail: string } {
  const project = projectName(s.name, ctx.workspace);
  const r = run("docker", [
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
  if (r.code !== 0) return { ok: false, detail: r.err || "docker ps failed" };
  const rows = r.out.split("\n").filter(Boolean);
  if (!rows.length)
    return {
      ok: false,
      detail: `${project}${service ? `/${service}` : ""}: not running`,
    };
  const bad = rows.filter((row) => {
    const [, state, status] = row.split("\t");
    return (
      state !== "running" || /\((unhealthy|health: starting)\)/.test(status)
    );
  });
  return bad.length
    ? { ok: false, detail: bad.join("; ") }
    : { ok: true, detail: `${rows.length} container(s) running` };
}
