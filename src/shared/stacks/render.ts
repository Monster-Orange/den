/**
 * Pure planning for stacks: project names, container names, the compose
 * override, the link networks and the edge routes. No I/O.
 */
import * as yaml from "yaml";
import {
  edgeDomains,
  routeEntryPoint,
  routeHost,
  routerTls,
} from "../edge/render.js";
import type { EdgeConfig } from "../edge/types.js";
import type { ResolvedProject, StackConfig } from "./types.js";

import { product } from "../product.js";

/** D53: Den's mark on each container of a stack it starts (runtime.ts). */
export const DEN_OWNER_LABEL = "den.stack.owner";
const NAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

export function assertStackName(n: string): void {
  if (!NAME_RE.test(n))
    throw new Error(
      `stack name "${n}" must be lowercase letters, digits and dashes`,
    );
}

export function projectName(stack: string, workspace: string): string {
  return `${stack}-${workspace}`;
}

/**
 * Container name for a stack service. Always Compose's per-project default:
 * the override resets any pinned `container_name`, which would otherwise
 * collide when the same repo runs in two workspaces.
 */
export function containerName(project: string, service: string): string {
  return `${project}-${service}-1`;
}

export function linkNetwork(
  consumer: string,
  provider: string,
  ws: string,
): string {
  return `${consumer}-${ws}--${provider}`;
}

export function parseTarget(target: string): { service: string; port: number } {
  const m = /^([a-zA-Z0-9][\w.-]*):(\d{1,5})$/.exec(target);
  if (!m) throw new Error(`route target "${target}" must be <service>:<port>`);
  return { service: m[1], port: Number(m[2]) };
}

/** Expand `{stack.service}` placeholders to container names. */
export function expandEnv(
  env: Record<string, string>,
  ws: string,
  known: Record<string, StackConfig>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env))
    out[k] = v.replace(
      /\{([a-z0-9-]+)\.([\w.-]+)\}/g,
      (_m, s: string, svc: string) => {
        if (!known[s]) throw new Error(`env ${k} names unknown stack "${s}"`);
        return containerName(projectName(s, ws), svc);
      },
    );
  return out;
}

/** Providers named in `{stack.service}` placeholders → their services. */
export function providerServices(stack: StackConfig): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const v of Object.values(stack.env))
    for (const m of v.matchAll(/\{([a-z0-9-]+)\.([\w.-]+)\}/g))
      (out[m[1]] ??= []).includes(m[2]) || out[m[1]].push(m[2]);
  return out;
}

/** Start order: every stack after the stacks it uses. Throws on cycles. */
export function startOrder(
  names: string[],
  all: Record<string, StackConfig>,
): string[] {
  const order: string[] = [];
  const state = new Map<string, "visiting" | "done">();
  const visit = (n: string, trail: string[]) => {
    if (!all[n]) throw new Error(`unknown stack "${n}"`);
    if (state.get(n) === "done") return;
    if (state.get(n) === "visiting")
      throw new Error(
        `stacks use each other in a cycle: ${[...trail, n].join(" → ")}`,
      );
    state.set(n, "visiting");
    for (const u of all[n].uses) visit(u, [...trail, n]);
    state.set(n, "done");
    order.push(n);
  };
  names.forEach((n) => visit(n, []));
  return order;
}

/**
 * Services that refer to a provider: their resolved environment names one of
 * the provider's container names. Only these join the link network, so a
 * consumer's postgres/redis never become resolvable from the provider.
 */
export function linkedServices(
  stack: StackConfig,
  provider: string,
  resolved: ResolvedProject,
  ws: string,
): string[] {
  const names = (providerServices(stack)[provider] ?? []).map((svc) =>
    containerName(projectName(provider, ws), svc),
  );
  return Object.entries(resolved.services)
    .filter(([, def]) =>
      Object.values(def.environment ?? {}).some(
        (v) => typeof v === "string" && names.some((n) => v.includes(n)),
      ),
    )
    .map(([svc]) => svc)
    .sort();
}

/**
 * The compose override: drop every published host port and pinned container
 * name, and put the services that refer to a provider on its link network.
 * Written as text because `!reset` is a Compose tag, not plain YAML.
 */
export function renderOverride(
  stack: StackConfig,
  resolved: ResolvedProject,
  ws: string,
  /** D53: this install's mark, on every container (DEN_OWNER_LABEL). */
  owner?: string,
): string {
  const links = stack.uses.map((p) => ({
    net: linkNetwork(stack.name, p, ws),
    services: linkedServices(stack, p, resolved, ws),
  }));
  const unknown = Object.keys(stack.serviceEnv ?? {}).filter(
    (s) => !(s in resolved.services),
  );
  if (unknown.length)
    throw new Error(
      `stack "${stack.name}": service_env names "${unknown.join('", "')}", ` +
        `which the compose project does not have (${Object.keys(resolved.services).sort().join(", ")})`,
    );
  const lines = [
    `# Generated by \`${product().cli} stack up\`: no host ports (reach services via the`,
    "# edge) and no pinned container names (each workspace is its own project).",
    "services:",
  ];
  for (const [svc, def] of Object.entries(resolved.services).sort()) {
    const body: string[] = [];
    // Compose merges labels by key: the project's own stay.
    if (owner)
      body.push(
        "    labels:",
        `      ${JSON.stringify(DEN_OWNER_LABEL)}: ${JSON.stringify(owner)}`,
      );
    if (def.ports && def.ports.length) body.push("    ports: !reset []");
    if (def.container_name) body.push("    container_name: !reset null");
    const check = stack.healthchecks?.[svc];
    if (check)
      body.push("    healthcheck:", `      test: ${JSON.stringify(check)}`);
    const vars = stack.serviceEnv?.[svc];
    if (vars && Object.keys(vars).length) {
      // Compose merges `environment` by key across files, so these win.
      body.push("    environment:");
      for (const [k, v] of Object.entries(vars).sort())
        body.push(`      ${JSON.stringify(k)}: ${JSON.stringify(v)}`);
    }
    const mine = links
      .filter((l) => l.services.includes(svc))
      .map((l) => l.net);
    if (mine.length) {
      // Compose merges service networks by key, so listing the base ones keeps them.
      const base = Object.keys(def.networks ?? { default: null });
      body.push("    networks:");
      for (const n of [...base, ...mine])
        body.push(`      ${JSON.stringify(n)}: {}`);
    }
    if (body.length) lines.push(`  ${JSON.stringify(svc)}:`, ...body);
  }
  if (!lines.some((l) => /^ {2}"/.test(l))) lines.push("  {}");
  const used = links.filter((l) => l.services.length).map((l) => l.net);
  if (used.length) {
    lines.push("networks:");
    for (const n of used)
      lines.push(
        `  ${JSON.stringify(n)}:`,
        `    name: ${JSON.stringify(n)}`,
        "    external: true",
      );
  }
  return lines.join("\n") + "\n";
}

/** Docker networks the edge must join to reach each routed service. */
export function routedNetworks(
  stack: StackConfig,
  resolved: ResolvedProject,
): string[] {
  const nets = new Set<string>();
  for (const target of Object.values(stack.routes)) {
    const { service } = parseTarget(target);
    const def = resolved.services[service];
    if (!def)
      throw new Error(
        `stack ${stack.name}: route target service "${service}" not in compose`,
      );
    const first = Object.keys(def.networks ?? { default: null })[0];
    nets.add(resolved.networks?.[first]?.name ?? `${resolved.name}_${first}`);
  }
  return [...nets].sort();
}

/** Edge dynamic config for one stack: `<route>.<stack>.<domain>` → container. */
export function renderStackRoutes(
  edge: EdgeConfig,
  stack: StackConfig,
  resolved: ResolvedProject,
): string {
  const routers: Record<string, unknown> = {};
  const services: Record<string, unknown> = {};
  for (const [route, target] of Object.entries(stack.routes).sort()) {
    if (!NAME_RE.test(route))
      throw new Error(
        `route "${route}" must be lowercase letters, digits and dashes`,
      );
    const { service, port } = parseTarget(target);
    const key = `stack-${stack.name}-${route}`;
    routers[key] = {
      entryPoints: [routeEntryPoint(edge)],
      rule: edgeDomains(edge)
        .map((d) => `Host(\`${routeHost(`${route}.${stack.name}`, d)}\`)`)
        .join(" || "),
      service: key,
      ...routerTls(edge),
    };
    services[key] = {
      loadBalancer: {
        servers: [
          {
            url: `http://${containerName(resolved.name, service)}:${port}`,
          },
        ],
      },
    };
  }
  return (
    `# Generated by \`${product().cli} stack up ${stack.name}\`.\n` +
    yaml.stringify({ http: { routers, services } })
  );
}

/**
 * Compose-project suffix for a den workspace: its own name, except that
 * the `default` workspace keeps the original `main` projects (and so their
 * volumes and data).
 */
export function stackWorkspace(denWorkspace: string): string {
  return denWorkspace === "default" ? "main" : denWorkspace;
}
