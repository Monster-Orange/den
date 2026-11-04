/**
 * Applications: the boundary between an org and its repos.
 *
 *   Org > Application > Repo > Services
 *
 *  - declared: `applications:` in config/den.yml, plus any repo whose own
 *    `.den.yml` sets `application:` (the repo's own setting wins);
 *  - repo:     every other repo is its own application, named after the repo
 *    (a mono-repo: Application == Repo).
 *
 * An application's `repos` are the ones with a runtime (services). Modules and
 * libraries are placed the same way but listed as `contributors`: code that
 * ships inside another repo's runtime, with no status of its own.
 *
 * Pure: callers pass the config, manifest applications and kinds.
 */
import type { ApplicationConfig } from "./den-config.js";
import type { RepoKind } from "./types/index.js";

export interface ApplicationContributor {
  repo: string;
  kind: Exclude<RepoKind, "service">;
  /** Repos whose runtime this code ships in. */
  contributesTo: string[];
}

export interface Application {
  name: string;
  title: string;
  description?: string;
  /** Who builds it. */
  owner?: string;
  /** declared in config or a manifest, or a repo standing as its own application. */
  source: "declared" | "repo";
  /** Repos with a runtime: these get status, up and down. */
  repos: string[];
  /** Modules and libraries in the application: no runtime of their own. */
  contributors: ApplicationContributor[];
}

export function resolveApplications(opts: {
  /** Repos to place (normally the workspace's). */
  repos: string[];
  config?: Record<string, ApplicationConfig>;
  /** repo → application named in that repo's manifest. */
  manifestApplications?: Record<string, string>;
  /** repo → kind; repos not listed are services. */
  kinds?: Record<string, RepoKind>;
  /** repo → repos it contributes to (for modules and libraries). */
  contributesTo?: Record<string, string[]>;
}): Application[] {
  const inScope = new Set(opts.repos);
  const placed = new Set<string>();
  const apps = new Map<string, Application>();
  const declare = (name: string): Application => {
    let a = apps.get(name);
    if (!a) {
      const c = opts.config?.[name];
      a = {
        name,
        title: c?.title ?? name,
        ...(c?.description ? { description: c.description } : {}),
        ...(c?.owner ? { owner: c.owner } : {}),
        source: "declared",
        repos: [],
        contributors: [],
      };
      apps.set(name, a);
    }
    return a;
  };
  const place = (a: Application, repo: string) => {
    if (!inScope.has(repo) || placed.has(repo)) return;
    placed.add(repo);
    a.repos.push(repo);
  };

  // Config order first; declared applications exist even when none of their
  // repos are in scope.
  for (const name of Object.keys(opts.config ?? {})) declare(name);
  // A repo's own manifest wins over the team list.
  for (const [repo, name] of Object.entries(opts.manifestApplications ?? {}))
    place(declare(name), repo);
  for (const [name, c] of Object.entries(opts.config ?? {}))
    for (const repo of c.repos ?? []) place(declare(name), repo);

  // Every other repo is its own application. A declared application that
  // already carries the repo's name takes it in instead.
  const standalone: Application[] = [];
  for (const repo of [...opts.repos].sort()) {
    if (placed.has(repo)) continue;
    const named = apps.get(repo);
    if (named) {
      place(named, repo);
      continue;
    }
    placed.add(repo);
    standalone.push({
      name: repo,
      title: repo,
      source: "repo",
      repos: [repo],
      contributors: [],
    });
  }

  return [...apps.values(), ...standalone].map((a) =>
    splitByKind(a, opts.kinds, opts.contributesTo),
  );
}

function splitByKind(
  a: Application,
  kinds: Record<string, RepoKind> = {},
  contributesTo: Record<string, string[]> = {},
): Application {
  const repos: string[] = [];
  const contributors: ApplicationContributor[] = [];
  for (const repo of [...a.repos].sort()) {
    const kind = kinds[repo] ?? "service";
    if (kind === "service") repos.push(repo);
    else
      contributors.push({
        repo,
        kind,
        contributesTo: contributesTo[repo] ?? [],
      });
  }
  return { ...a, repos, contributors };
}

/** The application named `name`. */
export function findApplication(
  apps: Application[],
  name: string,
): Application | undefined {
  return apps.find((a) => a.name === name);
}
