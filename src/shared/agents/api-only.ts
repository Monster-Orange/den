/**
 * D47: the services agents may reach only through their API.
 *
 * A repo's manifest says `agents: api_only` (with `data_paths:` and an
 * OrbStack `machine:` when it has them). Den gathers those across every
 * workspace into one rules file; each agent's PreToolUse hook reads it on
 * every call (guardrails/api-only.mjs), so a change applies at once,
 * without a restart. Den knows nothing of which service it is.
 *
 * A guardrail, not a security boundary: an agent that can reach the Docker
 * engine can get past it with a program of its own. The hard boundary is
 * an agent that can't reach that engine.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as yaml from "yaml";
import { readManifest } from "../manifest/read-manifest.js";
import { readCatalog } from "../environment-manager/catalog.js";
import {
  listWorkspaceServices,
  readWorkspacesFile,
} from "../environment-manager/workspaces.js";
import type { RawManifest } from "../types/index.js";
import type { ApiOnlyArgs } from "./guardrails.js";

/** One service, as the hook reads it. */
export interface ApiOnlyService {
  /** What the agent is told: the manifest's name. */
  name: string;
  /** Its compose project: containers `<project>-…`, volumes `<project>_…`. */
  project: string;
  /** Containers and volumes named outright in its compose files. */
  containers: string[];
  volumes: string[];
  /** Its compose services and volumes: `<project>-<service>-<n>`, `<project>_<volume>`. */
  composeServices: string[];
  composeVolumes: string[];
  /** Its data paths, absolute. */
  paths: string[];
  /** Its OrbStack machine, when it runs in one. */
  machine?: string;
}

export interface ApiOnlyRules {
  services: ApiOnlyService[];
}

const COMPOSE_FILES = [
  "compose.yaml",
  "compose.yml",
  "docker-compose.yaml",
  "docker-compose.yml",
];

/** container_name and named volumes in a repo's compose files (best effort). */
function composeNames(
  repo: string,
  m: RawManifest,
): {
  containers: string[];
  volumes: string[];
  composeServices: string[];
  composeVolumes: string[];
} {
  const containers: string[] = [];
  const volumes: string[] = [];
  const composeServices: string[] = [];
  const composeVolumes: string[] = [];
  const dir = path.resolve(repo, m.compose?.dir ?? ".");
  const files = m.compose?.files?.length
    ? m.compose.files.map((f) => path.resolve(dir, f))
    : COMPOSE_FILES.map((f) => path.join(dir, f));
  for (const f of files) {
    let doc: unknown;
    try {
      doc = yaml.parse(fs.readFileSync(f, "utf-8"));
    } catch {
      continue;
    }
    const d = (doc ?? {}) as {
      services?: Record<string, { container_name?: unknown }>;
      volumes?: Record<string, { name?: unknown } | null>;
    };
    for (const [key, svc] of Object.entries(d.services ?? {})) {
      composeServices.push(key);
      if (typeof svc?.container_name === "string")
        containers.push(svc.container_name);
    }
    for (const [key, v] of Object.entries(d.volumes ?? {})) {
      if (typeof v?.name === "string") volumes.push(v.name);
      else composeVolumes.push(key);
    }
  }
  return { containers, volumes, composeServices, composeVolumes };
}

const expandHome = (p: string, home: string): string =>
  p === "~" || p.startsWith("~/") ? path.join(home, p.slice(1)) : p;

/** The service a manifest declares api_only, or null. */
export function apiOnlyService(
  repo: string,
  m: RawManifest | null,
  home: string = os.homedir(),
): ApiOnlyService | null {
  if (!m || m.agents !== "api_only") return null;
  const project = m.compose?.name ?? m.name;
  const names = composeNames(repo, m);
  return {
    name: m.name,
    project,
    ...names,
    paths: (m.data_paths ?? []).map((p) =>
      path.resolve(repo, expandHome(p, home)),
    ),
    ...(m.machine ? { machine: m.machine } : {}),
  };
}

/** Merge one checkout's service into the list (one entry per name). */
function add(list: ApiOnlyService[], s: ApiOnlyService): void {
  const had = list.find((x) => x.name === s.name);
  if (!had) {
    list.push(s);
    return;
  }
  const u = (a: string[], b: string[]) => [...new Set([...a, ...b])];
  had.containers = u(had.containers, s.containers);
  had.volumes = u(had.volumes, s.volumes);
  had.paths = u(had.paths, s.paths);
  had.composeServices = u(had.composeServices, s.composeServices);
  had.composeVolumes = u(had.composeVolumes, s.composeVolumes);
  had.machine ??= s.machine;
}

/** Every api_only service in every workspace's checkouts. */
export function gatherApiOnly(
  read: (repo: string) => RawManifest | null = readManifest,
): ApiOnlyRules {
  const services: ApiOnlyService[] = [];
  let file;
  let catalog;
  try {
    file = readWorkspacesFile();
    catalog = readCatalog();
  } catch {
    return { services };
  }
  for (const [ws, cfg] of Object.entries(file.workspaces ?? {})) {
    let resolved;
    try {
      resolved = listWorkspaceServices(cfg, catalog, ws);
    } catch {
      continue;
    }
    for (const r of resolved) {
      const s = apiOnlyService(r.repoPath, read(r.repoPath));
      if (s) add(services, s);
    }
  }
  return { services };
}

/** Where the rules and the audit live: Den's state, beside the agents. */
export function apiOnlyFiles(stateDir: string): ApiOnlyArgs {
  return {
    rules: path.join(stateDir, "agents", "api-only.json"),
    audit: path.join(stateDir, "audit", "api-only.jsonl"),
  };
}

/**
 * Write the rules file (0600) and say where it and the audit are; null when
 * no service is api_only (the file is removed, so a hook reads nothing).
 */
export function writeApiOnlyRules(
  stateDir: string,
  rules: ApiOnlyRules = gatherApiOnly(),
): ApiOnlyArgs | null {
  const files = apiOnlyFiles(stateDir);
  if (!rules.services.length) {
    fs.rmSync(files.rules, { force: true });
    return null;
  }
  fs.mkdirSync(path.dirname(files.rules), { recursive: true });
  const tmp = `${files.rules}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(rules, null, 2)}\n`, {
    mode: 0o600,
  });
  fs.renameSync(tmp, files.rules);
  return files;
}

/** The audit's denials, newest last (for doctor and the page). */
export function readApiOnlyAudit(
  stateDir: string,
  max = 50,
): Array<Record<string, unknown>> {
  let text = "";
  try {
    text = fs.readFileSync(apiOnlyFiles(stateDir).audit, "utf-8");
  } catch {
    return [];
  }
  const out: Array<Record<string, unknown>> = [];
  for (const line of text.trim().split("\n").slice(-max)) {
    try {
      out.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      /* a torn line */
    }
  }
  return out;
}
