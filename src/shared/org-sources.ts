/**
 * Orgs are Den's own concept; sources are bindings (ORG-1d, ORG-SPEC §1).
 *
 * An org is a key of `orgs:`. It may name the git hosts its repos live on
 * (`sources: [{host: github, owner: acme}, {host: gitlab, group: globex}]`)
 * and list repos outright (`repos: [widget]`). A repo's org resolves:
 *
 *   1. an org whose `repos` lists it
 *   2. an org with a source that claims the repo's owner
 *   3. (legacy) the repo's bare GitHub owner, from `gh: owner/repo`
 *
 * An org that sets neither `sources` nor `repos` is a legacy org: the GitHub
 * owner of its own name (ORG-1a). So a config with no new keys resolves
 * exactly as before, and only the new keys can raise an error (C1).
 *
 * A source claims an owner; it never brings credentials of its own here.
 * GitHub sources clone through the user's gh, a repo with no source clones
 * from its catalog `remote:` through plain git (SEC-0).
 */
import { ConfigError, type ConfigIssue } from "./config-error.js";
import type { ServiceCatalog, ServiceCatalogEntry } from "./types/index.js";

/** `orgs.<id>.sources[i]`: a git host and the owner (or group) it claims. */
export interface OrgSourceConfig {
  /** `github` (built in), or a git-host id such as `gitlab` (ORG-1e). */
  host: string;
  owner?: string;
  group?: string;
}

/** One `orgs.<id>` entry. */
export interface WorkOrgConfig {
  label?: string;
  color?: string;
  /** ORG-1d: the git hosts and owners this org's repos come from. */
  sources?: OrgSourceConfig[];
  /** ORG-1d: repos that belong to this org whatever their owner. */
  repos?: string[];
}

export type WorkOrgsConfig = Record<string, WorkOrgConfig>;

/** Where a repo lives: a host id (`github`, else the remote's hostname) and owner path. */
export interface RepoOwner {
  host: string;
  hostname: string;
  owner: string;
}

const lower = (s: string): string => s.toLowerCase();
const HOST_RE = /^[a-z][a-z0-9-]*$/;
const GH_OWNER_RE = /^[A-Za-z0-9][A-Za-z0-9-]*$/;
const GROUP_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;

/** True when the entry uses the ORG-1d keys (its sources are then exactly `sources`). */
export function isSourcedOrg(entry: WorkOrgConfig | undefined): boolean {
  return (
    !!entry &&
    typeof entry === "object" &&
    ("sources" in entry || "repos" in entry)
  );
}

const sourceOwner = (s: OrgSourceConfig): string =>
  (s.owner ?? s.group ?? "").trim();

/**
 * Check the ORG-1d keys of `orgs:` and throw a ConfigError listing every
 * problem (0.3.0-dev.40; it threw on the first), each naming its key. A
 * problem with a source skips the rest of that source; one with `sources`
 * or `repos` as a whole skips that key. Entries without them are not
 * looked at (C1). A repo listed by two orgs, or an owner claimed by two
 * orgs' sources (or by a source and a legacy org of that name), names both.
 */
export function validateOrgSources(orgs: unknown, file: string): void {
  if (!orgs || typeof orgs !== "object" || Array.isArray(orgs)) return;
  const issues: ConfigIssue[] = [];
  // `text` is the message as it reads after "<file>: ".
  const bad = (key: string, text: string): void => {
    const message = text.startsWith(key)
      ? text.slice(key.length).replace(/^:?\s*/, "")
      : text;
    issues.push({ file, key, message, text });
  };
  const entries = Object.entries(orgs as Record<string, unknown>);
  const repoAt = new Map<string, string>();
  const ownerAt = new Map<string, string>();
  for (const [id, raw] of entries) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const e = raw as Record<string, unknown>;
    const at = `orgs.${id}`;
    if ("sources" in e) {
      if (!Array.isArray(e.sources))
        bad(
          `${at}.sources`,
          `${at}.sources must be a list of { host, owner } or { host, group }`,
        );
      else
        e.sources.forEach((s: unknown, i: number) => {
          const k = `${at}.sources[${i}]`;
          if (!s || typeof s !== "object" || Array.isArray(s))
            return bad(
              k,
              `${k} must be a map: { host: github, owner: <owner> }`,
            );
          const src = s as Record<string, unknown>;
          const unknown = Object.keys(src).find(
            (key) => !["host", "owner", "group"].includes(key),
          );
          if (unknown !== undefined)
            return bad(
              k,
              `${k}: unknown key "${unknown}" (known: host, owner, group)`,
            );
          if (typeof src.host !== "string" || !HOST_RE.test(src.host))
            return bad(
              `${k}.host`,
              `${k}.host must be a git host id such as github or gitlab`,
            );
          const hasOwner = src.owner !== undefined;
          const hasGroup = src.group !== undefined;
          if (hasOwner === hasGroup)
            return bad(k, `${k} needs exactly one of owner or group`);
          const key = hasOwner ? "owner" : "group";
          const v = src[key];
          const ok =
            typeof v === "string" &&
            (src.host === "github" ? GH_OWNER_RE : GROUP_RE).test(v.trim());
          if (!ok)
            return bad(
              `${k}.${key}`,
              src.host === "github"
                ? `${k}.${key} must be a GitHub owner name (letters, digits and hyphens)`
                : `${k}.${key} must be an owner or group path`,
            );
          const claim = `${src.host}:${lower((v as string).trim())}`;
          const prior = ownerAt.get(claim);
          if (prior && !prior.startsWith(`${at}.`))
            return bad(
              k,
              `${src.host} owner ${(v as string).trim()} is claimed by both ${prior} and ${k}`,
            );
          if (!prior) ownerAt.set(claim, k);
        });
    }
    if ("repos" in e) {
      if (
        !Array.isArray(e.repos) ||
        e.repos.some((r) => typeof r !== "string" || !r.trim())
      )
        bad(`${at}.repos`, `${at}.repos must be a list of repo names`);
      else
        for (const r of e.repos as string[]) {
          const prior = repoAt.get(r.trim());
          if (prior && prior !== `${at}.repos`)
            bad(
              `${at}.repos`,
              `repo ${r.trim()} is claimed by both ${prior} and ${at}.repos`,
            );
          else repoAt.set(r.trim(), `${at}.repos`);
        }
    }
  }
  // A legacy org is the GitHub owner of its own name: a source elsewhere that
  // claims that owner would split it silently.
  for (const [id, raw] of entries) {
    if (isSourcedOrg(raw as WorkOrgConfig)) continue;
    const prior = ownerAt.get(`github:${lower(id)}`);
    if (prior)
      bad(
        `orgs.${id}`,
        `github owner ${id} is claimed by both ${prior} and orgs.${id} ` +
          `(an org with no sources: is the GitHub owner of its own name)`,
      );
  }
  if (issues.length) throw new ConfigError(issues);
}

/** `gh: owner/repo`'s owner, as spelled, or "" (the legacy orgOf). */
export function ghOwnerOf(entry: ServiceCatalogEntry | undefined): string {
  const gh = entry?.gh ?? "";
  const slash = gh.indexOf("/");
  return slash > 0 ? gh.slice(0, slash) : "";
}

/** Host, hostname and owner path of a git URL; null for a local path or an unparsable one. */
export function parseRemote(remote: string): RepoOwner | null {
  const r = remote.trim();
  let hostname = "";
  let p = "";
  const scp = /^[A-Za-z0-9._-]+@([A-Za-z0-9.-]+):(.+)$/.exec(r);
  if (scp) {
    hostname = scp[1];
    p = scp[2];
  } else {
    try {
      const u = new URL(r);
      if (u.protocol === "file:") return null;
      hostname = u.hostname;
      p = u.pathname;
    } catch {
      return null;
    }
  }
  const parts = p
    .replace(/\.git$/, "")
    .split("/")
    .filter(Boolean);
  if (!hostname || parts.length < 2) return null;
  const host = lower(hostname) === "github.com" ? "github" : lower(hostname);
  return {
    host,
    hostname: lower(hostname),
    owner: parts.slice(0, -1).join("/"),
  };
}

/** Where a catalogued repo lives: `gh` first (GitHub shorthand), else its `remote`. */
export function repoOwnerOf(
  entry: ServiceCatalogEntry | undefined,
): RepoOwner | null {
  const gh = ghOwnerOf(entry);
  if (gh) return { host: "github", hostname: "github.com", owner: gh };
  return entry?.remote ? parseRemote(entry.remote) : null;
}

/**
 * Whether `src` claims `owner`. A GitHub source claims a github.com owner;
 * another host's source claims the owner (or a subgroup of it) on a remote
 * whose hostname is `<host>.com` or starts with `<host>.`.
 */
export function sourceClaims(src: OrgSourceConfig, owner: RepoOwner): boolean {
  const want = lower(sourceOwner(src));
  if (!want) return false;
  const have = lower(owner.owner);
  if (src.host === "github") return owner.host === "github" && have === want;
  const onHost =
    owner.hostname === `${src.host}.com` ||
    owner.hostname.startsWith(`${src.host}.`);
  return onHost && (have === want || have.startsWith(`${want}/`));
}

/** The org that lists `repo` in its `repos`, and the org whose source claims its owner. */
function claimsOf(
  repo: string,
  catalog: ServiceCatalog,
  orgs: WorkOrgsConfig,
): { listed?: string; claimed?: { org: string; source: OrgSourceConfig } } {
  const out: ReturnType<typeof claimsOf> = {};
  const owner = repoOwnerOf(catalog[repo]);
  for (const [id, e] of Object.entries(orgs)) {
    if (!isSourcedOrg(e)) continue;
    if (!out.listed && Array.isArray(e.repos) && e.repos.includes(repo))
      out.listed = id;
    if (!out.claimed && owner && Array.isArray(e.sources)) {
      const src = e.sources.find((s) => sourceClaims(s, owner));
      if (src) out.claimed = { org: id, source: src };
    }
  }
  return out;
}

/** The org `repo` belongs to (see the module comment), or "" when none. */
export function orgOfRepo(
  repo: string,
  catalog: ServiceCatalog,
  orgs: WorkOrgsConfig = {},
): string {
  const { listed, claimed } = claimsOf(repo, catalog, orgs);
  if (listed) return listed;
  if (claimed) return claimed.org;
  const gh = ghOwnerOf(catalog[repo]);
  if (gh) return gh;
  const remote = repoOwnerOf(catalog[repo]);
  return remote?.host === "github" ? remote.owner : "";
}

/**
 * The source `repo` clones through: one of its own org's sources that claims
 * its owner. Null when it has none: a legacy repo (GitHub by its `gh`), or a
 * repo of an org with no matching source (it clones from `remote:`).
 */
export function repoSource(
  repo: string,
  catalog: ServiceCatalog,
  orgs: WorkOrgsConfig = {},
): OrgSourceConfig | null {
  const { listed, claimed } = claimsOf(repo, catalog, orgs);
  if (listed) {
    const owner = repoOwnerOf(catalog[repo]);
    const srcs = orgs[listed]?.sources ?? [];
    return (owner && srcs.find((s) => sourceClaims(s, owner))) || null;
  }
  return claimed?.source ?? null;
}

/** The org's GitHub owners: its own name for a legacy org, else its GitHub sources'. */
export function githubOwnersOf(
  org: string,
  orgs: WorkOrgsConfig = {},
): string[] {
  const key = Object.keys(orgs).find((k) => lower(k) === lower(org));
  const e = key === undefined ? undefined : orgs[key];
  if (!isSourcedOrg(e)) return [org];
  return (e?.sources ?? [])
    .filter((s) => s.host === "github")
    .map(sourceOwner)
    .filter(Boolean);
}

/** True when the org reaches GitHub (discovery, branches, releases work for it). */
export function orgHasGithub(org: string, orgs: WorkOrgsConfig = {}): boolean {
  return githubOwnersOf(org, orgs).length > 0;
}

/** The ORG-1d org whose GitHub source claims GitHub owner `owner`, if any. */
export function orgClaimingOwner(
  owner: string,
  orgs: WorkOrgsConfig = {},
): string | undefined {
  const o: RepoOwner = { host: "github", hostname: "github.com", owner };
  return Object.entries(orgs).find(
    ([, e]) =>
      isSourcedOrg(e) &&
      Array.isArray(e.sources) &&
      e.sources.some((s) => sourceClaims(s, o)),
  )?.[0];
}
