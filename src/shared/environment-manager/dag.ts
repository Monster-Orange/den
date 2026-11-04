/**
 * Dependency DAG for local service startup ordering.
 *
 * Reads `depends_on` from each service's .den.yml and produces a
 * topologically sorted startup order (dependencies before dependents).
 *
 * depends_on entries are service addresses: "tasks-runner", "shop/api".
 */

import { readManifest } from "../manifest/read-manifest.js";
import { depService, normalizeDep } from "../manifest/deps.js";
import type { ServiceCatalog, WorkspaceConfig } from "../types/index.js";
import {
  parseAddress,
  resolveServiceSource,
  resolveDepAddress,
} from "./workspaces.js";

/**
 * Read `depends_on` for one service address from its manifest.
 * Returns [] if the manifest is absent or the service has no declared deps.
 */
function readDepsForAddress(
  address: string,
  catalog: ServiceCatalog,
  workspace: WorkspaceConfig,
  workspaceName: string,
): string[] {
  const resolved = resolveServiceSource(
    address,
    workspaceName,
    workspace,
    catalog,
  );
  if (!resolved) return [];
  const { subsystem } = parseAddress(address, catalog);
  const manifest = readManifest(resolved.repoPath);
  const rawDeps = manifest?.services?.[subsystem]?.depends_on ?? [];
  // Normalize bare repo deps to their entrypoint address ("files-api" →
  // "files-api/api" when files-api declares entrypoint: api).
  return rawDeps.map((dep) =>
    resolveDepAddress(depService(dep), catalog, workspace, workspaceName),
  );
}

/**
 * Return the deps flagged with `wait: true` for one service address, resolved
 * to canonical addresses. The workspace runner calls this before starting a
 * service to decide which deps to block on (`waitForReady`).
 */
export function getWaitDeps(
  address: string,
  catalog: ServiceCatalog,
  workspace: WorkspaceConfig,
  workspaceName: string,
): string[] {
  const resolved = resolveServiceSource(
    address,
    workspaceName,
    workspace,
    catalog,
  );
  if (!resolved) return [];
  const { subsystem } = parseAddress(address, catalog);
  const manifest = readManifest(resolved.repoPath);
  const rawDeps = manifest?.services?.[subsystem]?.depends_on ?? [];
  return rawDeps
    .map(normalizeDep)
    .filter((d) => d.wait)
    .map((d) =>
      resolveDepAddress(d.service, catalog, workspace, workspaceName),
    );
}

/**
 * Expand an explicit start list with SAME-REPO `wait: true` dependencies whose
 * health check is actively failing, deps-first.
 *
 * An explicit address (card ▶ up) runs only that address, while the exec
 * runner blocks on its `wait: true` deps' HEALTH before starting it — and for
 * a sibling subsystem, the thing that makes the dep healthy is the dep's own
 * `up`, which nothing else will run. That inverted the order every manifest
 * intends (init the dep, THEN wait) into a wait that could only time out.
 *
 * Cross-repo deps are deliberately not expanded: they belong to another
 * system's lifecycle, and waiting is the correct posture there. Deps whose
 * health is "ok" need nothing; "unknown" (no check / no manifest) cannot
 * deadlock the wait because readiness skips it.
 *
 * Injected callbacks keep this pure: `repoOf`/`waitDepsOf` wrap the catalog
 * and manifest lookups, `isFailing` wraps resolve + health check.
 */
export async function expandSameRepoWaitDeps(
  ordered: string[],
  deps: {
    repoOf: (addr: string) => string;
    waitDepsOf: (addr: string) => string[];
    isFailing: (addr: string) => Promise<boolean>;
    /**
     * Canonical identity for an address — repo + subsystem, so two spellings
     * of the SAME service collapse. Several address forms can name one service
     * (a bare repo name vs `repo/entrypoint`, or a `repo/repo` dep against a
     * manifest whose service key equals the repo name), and treating those as
     * distinct would start it twice. Defaults to the address itself.
     */
    identityOf?: (addr: string) => string;
  },
): Promise<{ ordered: string[]; added: string[] }> {
  const idOf = deps.identityOf ?? ((addr: string) => addr);
  const expanded: string[] = [];
  const queued = new Set<string>(); // identities, not raw addresses
  // identity -> the CALLER's spelling of it. A hoisted dep must be emitted
  // under the address the caller listed, not the manifest's spelling of the
  // same service: downstream keys off the exact string (isPrimaryAddr in
  // local-dev.html compares the full address), so substituting a dep-only
  // spelling silently stops the live log auto-attaching.
  const explicitAddr = new Map<string, string>();
  for (const addr of ordered) {
    const id = idOf(addr);
    if (!explicitAddr.has(id)) explicitAddr.set(id, addr);
  }

  const addWithDeps = async (
    addr: string,
    stack: Set<string>,
  ): Promise<void> => {
    const id = idOf(addr);
    if (queued.has(id) || stack.has(id)) return; // done / dep cycle
    stack.add(id);
    const repoName = deps.repoOf(addr);

    // Filter BEFORE probing: an already-queued dep needs nothing, an in-stack
    // dep is a cycle addWithDeps would bounce anyway, and a cross-repo dep is
    // never expanded — none of them should cost a live health check.
    const candidates = deps
      .waitDepsOf(addr)
      .filter(
        (d) =>
          !queued.has(idOf(d)) &&
          !stack.has(idOf(d)) &&
          deps.repoOf(d) === repoName,
      );

    // Two tiers, because ordering and adding are different questions:
    //
    //  - A dep ALREADY in the run list is hoisted regardless of health. Health
    //    now says nothing about health later: on `restart` every listed service
    //    is going down anyway, so leaving a currently-healthy dep after its
    //    dependent means it gets torn down and recreated underneath a service
    //    that has already been restarted against it. Hoisting is also free —
    //    it needs no probe, which is why a whole-workspace start (where every
    //    dep is listed) costs zero probes.
    //  - A dep NOT in the run list is only pulled in when its health is
    //    actively failing, so a start never quietly grows into services the
    //    caller did not ask for.
    const unlisted = candidates.filter((d) => !explicitAddr.has(idOf(d)));
    // Probe concurrently — these are spawns/fetches, and doing them serially is
    // what put several seconds of dead air before the first log line.
    const failing = new Set(
      (
        await Promise.all(
          unlisted.map(async (d) => ((await deps.isFailing(d)) ? d : null)),
        )
      ).filter((d): d is string => d !== null),
    );
    // Recurse in the manifest's declared order so the result is deterministic.
    for (const depAddr of candidates) {
      if (explicitAddr.has(idOf(depAddr)) || failing.has(depAddr)) {
        await addWithDeps(depAddr, stack);
      }
    }

    stack.delete(id);
    queued.add(id);
    expanded.push(explicitAddr.get(id) ?? addr);
  };

  for (const addr of ordered) await addWithDeps(addr, new Set());
  return {
    ordered: expanded,
    added: expanded.filter((a) => !explicitAddr.has(idOf(a))),
  };
}

/**
 * Build the full dependency graph for the given seed addresses, following
 * transitive dependencies that are also present in the catalog.
 * Returns a map of address → direct dependency addresses.
 */
export function buildDependencyGraph(
  seedAddresses: string[],
  catalog: ServiceCatalog,
  workspace: WorkspaceConfig,
  workspaceName: string,
): Map<string, string[]> {
  const graph = new Map<string, string[]>();
  const queue = [...seedAddresses];

  while (queue.length > 0) {
    const addr = queue.pop()!;
    if (graph.has(addr)) continue;

    const deps = readDepsForAddress(
      addr,
      catalog,
      workspace,
      workspaceName,
    ).filter((d) => {
      const { repoName } = parseAddress(d, catalog);
      if (!catalog[repoName]) return false;
      // Only follow deps present in the workspace (check both explicit subsystem
      // address and bare repo-name key for mono-repo bare entries like "shop").
      return !!(workspace.services[d] ?? workspace.services[repoName]);
    });

    graph.set(addr, deps);

    for (const dep of deps) {
      if (!graph.has(dep)) queue.push(dep);
    }
  }

  return graph;
}

/**
 * Topologically sort the dependency graph using Kahn's algorithm.
 * Returns addresses in startup order: dependencies before dependents.
 * Throws if a cycle is detected.
 */
export function topoSort(graph: Map<string, string[]>): string[] {
  const reversedInDegree = new Map<string, number>();
  const reversedEdges = new Map<string, string[]>();
  for (const addr of graph.keys()) {
    reversedInDegree.set(addr, 0);
    reversedEdges.set(addr, []);
  }
  for (const [addr, deps] of graph.entries()) {
    reversedInDegree.set(addr, deps.length);
    for (const dep of deps) {
      reversedEdges.get(dep)!.push(addr);
    }
  }

  const ready: string[] = [];
  for (const [addr, deg] of reversedInDegree.entries()) {
    if (deg === 0) ready.push(addr);
  }

  const order: string[] = [];
  while (ready.length > 0) {
    const node = ready.shift()!;
    order.push(node);
    for (const dependent of reversedEdges.get(node) ?? []) {
      const newDeg = (reversedInDegree.get(dependent) ?? 1) - 1;
      reversedInDegree.set(dependent, newDeg);
      if (newDeg === 0) ready.push(dependent);
    }
  }

  if (order.length !== graph.size) {
    const cycle = [...graph.keys()].filter((a) => !order.includes(a));
    throw new Error(`Dependency cycle detected among: ${cycle.join(", ")}`);
  }

  return order;
}

/**
 * Given seed service addresses, return the full startup order including
 * transitive dependencies (deps first). Deps not in the catalog are ignored.
 */
export function resolveStartupOrder(
  addresses: string[],
  catalog: ServiceCatalog,
  workspace: WorkspaceConfig,
  workspaceName: string,
): string[] {
  const graph = buildDependencyGraph(
    addresses,
    catalog,
    workspace,
    workspaceName,
  );
  return topoSort(graph);
}
