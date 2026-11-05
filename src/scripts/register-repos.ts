/**
 * register-repos — where test discovery gets its repos.
 *
 * With Local Dev enabled (the default), smoke/performance/synthetics
 * discovery follows the ACTIVE WORKSPACE (see pillars/smoke/discover.ts):
 * the same repos you develop against are the repos tests run against, and a
 * fresh clone seeds every standard system repo managed out of the box.
 * In that mode there is nothing to register — this script just reports the
 * effective test sources.
 *
 * The legacy sibling-directory scan (interactive checkbox → writes
 * config/local/registered-repos.json, gitignored) remains for hosted /
 * no-local setups, where the workspace doesn't exist:
 *
 *   make register-repos                # report (or legacy scan when local off)
 *   make register-repos args=--legacy  # force the interactive sibling scan
 */

import * as fs from "fs";
import * as path from "path";
import inquirer from "inquirer";
import { parse as parseYaml } from "yaml";
import { getDistRoot } from "../shared/paths.js";
import { getReposRoot, isLocalEnabled } from "../shared/den-config.js";
import { getActiveWorkspace } from "../shared/environment-manager/workspaces.js";
import {
  defaultWorkspaceRepos,
  topUpDefaultWorkspace,
} from "../shared/environment-manager/default-workspace.js";

import { product } from "../shared/product.js";
import { plural } from "../shared/plural.js";
// Anchored to the den root, NOT process.cwd() — this script WRITES
// config/local/* and a cwd-derived root once put den files in another repo.
const ROOT = getDistRoot();
const CONFIG_DIR = path.join(ROOT, "config", "local");
const REGISTERED_FILE = path.join(CONFIG_DIR, "registered-repos.json");
const MANIFEST_NAMES = [
  `${product().manifestYml}`,
  `${product().manifestJson}`,
] as const;

// ── Mode selection (pure — unit tested) ───────────────────────────────────────

export type RegistrationPlan =
  | {
      mode: "workspace";
      workspaceName: string;
      repos: { name: string; managed: boolean }[];
    }
  | { mode: "defaults"; repos: string[] }
  | { mode: "legacy" };

/**
 * Decide what running register-repos should do.
 *
 * Workspace-driven discovery makes registration a no-op, so the only reasons
 * to run the legacy sibling scan are an explicit --legacy or Local Dev being
 * disabled (hosted setups, where no workspace exists to follow).
 */
export function planRegistration(opts: {
  localEnabled: boolean;
  legacyRequested: boolean;
  workspace: {
    name: string;
    services: Record<string, { mode?: string }>;
  } | null;
  defaultRepos: string[];
}): RegistrationPlan {
  if (opts.legacyRequested || !opts.localEnabled) return { mode: "legacy" };
  // An EMPTY workspace (declined seed, or user-emptied) reports like no
  // workspace: the defaults message says what the first den command will
  // do, where a zero-row workspace table says nothing actionable.
  if (opts.workspace && Object.keys(opts.workspace.services).length > 0) {
    return {
      mode: "workspace",
      workspaceName: opts.workspace.name,
      repos: Object.entries(opts.workspace.services).map(([name, svc]) => ({
        name,
        // Missing mode means dev-managed everywhere else in the system
        // (normalizeMode in workspaces.ts) — mirror that, never invert it.
        managed: svc.mode === "managed",
      })),
    };
  }
  return { mode: "defaults", repos: opts.defaultRepos };
}

// ── Legacy sibling scan (hosted / no-local setups) ────────────────────────────

interface Candidate {
  name: string;
  repoPath: string;
  description: string;
}

function scanForManifests(searchDir: string): Candidate[] {
  const candidates: Candidate[] = [];

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(searchDir, { withFileTypes: true });
  } catch {
    console.warn(`  Could not read directory: ${searchDir}`);
    return [];
  }

  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;

    const repoPath = path.join(searchDir, entry.name);

    // Skip den itself
    try {
      if (fs.realpathSync(repoPath) === fs.realpathSync(ROOT)) continue;
    } catch {
      continue;
    }

    const manifestPath = MANIFEST_NAMES.map((n) => path.join(repoPath, n)).find(
      (p) => fs.existsSync(p),
    );
    if (!manifestPath) continue;

    try {
      const raw = fs.readFileSync(manifestPath, "utf-8");
      const manifest = (
        manifestPath.endsWith(".yml") ? parseYaml(raw) : JSON.parse(raw)
      ) as {
        name?: string;
        smoke?: Record<string, unknown>;
        services?: Record<string, unknown>;
        synthetics?: unknown;
        journeys?: unknown;
        security?: Record<string, unknown>;
      };

      const capabilities: string[] = [];
      if (manifest.smoke)
        capabilities.push(`smoke(${Object.keys(manifest.smoke).join(",")})`);
      if (manifest.services)
        capabilities.push(
          `services(${Object.keys(manifest.services).join(",")})`,
        );
      if (manifest.synthetics) capabilities.push("synthetics");
      if (manifest.journeys) capabilities.push("journeys");
      if (manifest.security)
        capabilities.push(
          `security(${Object.keys(manifest.security).join(",")})`,
        );

      candidates.push({
        name: manifest.name ?? entry.name,
        repoPath,
        description: capabilities.length
          ? capabilities.join("  ")
          : "(no capabilities)",
      });
    } catch {
      // Malformed manifest — still offer it
      candidates.push({
        name: entry.name,
        repoPath,
        description: "(unreadable manifest)",
      });
    }
  }

  return candidates;
}

async function legacyScanAndSelect(): Promise<void> {
  console.log(`\n  ${product().cli} · Register Repos (legacy sibling scan)\n`);

  // Load current registrations
  let existing: string[] = [];
  if (fs.existsSync(REGISTERED_FILE)) {
    try {
      existing = JSON.parse(
        fs.readFileSync(REGISTERED_FILE, "utf-8"),
      ) as string[];
      console.log(
        `  Current: ${plural(existing.length, "repo")} registered for testing\n`,
      );
    } catch {
      /* corrupt file — start fresh */
    }
  }

  // Scan the configured repos root (defaults to the den root's parent)
  const parentDir = getReposRoot();
  console.log(
    `  Scanning ${parentDir} for ${product().manifestYml} / ${product().manifestJson} ...\n`,
  );
  const candidates = scanForManifests(parentDir);

  if (!candidates.length) {
    console.log(
      `  No sibling repos with ${product().manifestYml} or ${product().manifestJson} found.`,
    );
    console.log(
      "  Add custom paths manually to config/local/registered-repos.json\n",
    );
    return;
  }

  // Prompt
  const { selected } = await inquirer.prompt<{ selected: string[] }>([
    {
      type: "checkbox",
      name: "selected",
      message: `Select repos to register with ${product().cli} (space to toggle, enter to confirm):`,
      choices: candidates.map((c) => ({
        name: `${c.name.padEnd(20)} ${c.repoPath}   ${c.description}`,
        value: c.repoPath,
        checked: existing.includes(c.repoPath),
      })),
      pageSize: 15,
    },
  ]);

  // Persist
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(REGISTERED_FILE, JSON.stringify(selected, null, 2) + "\n");

  console.log(
    `\n  Registered ${plural(selected.length, "repo")} → config/local/registered-repos.json`,
  );
  console.log("  Run `make register-repos` again at any time to update.\n");
}

// ── Entry ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const legacyRequested = process.argv.includes("--legacy");
  const localEnabled = isLocalEnabled();

  // Converge first: a workspace seeded before a repo joined the blueprint
  // (tasks-api, say) is missing a first-class system repo — add it so the
  // report below shows the true standard set, not a stale snapshot. Skipped
  // on the legacy / no-local paths, which never read the workspace and must
  // not write it either.
  const toppedUp =
    legacyRequested || !localEnabled ? [] : topUpDefaultWorkspace();
  if (toppedUp.length > 0) {
    console.log(
      `\n  Added standard repo(s) to the default workspace: ${toppedUp.join(", ")} (managed)`,
    );
  }

  const active = getActiveWorkspace();
  const plan = planRegistration({
    localEnabled,
    legacyRequested,
    workspace: active
      ? { name: active.name, services: active.config.services }
      : null,
    defaultRepos: defaultWorkspaceRepos(),
  });

  if (plan.mode === "workspace") {
    console.log(`\n  ${product().cli} · Test repo sources\n`);
    console.log(
      `  Local Dev is enabled — test discovery follows your active workspace` +
        ` ("${plan.workspaceName}"):\n  the repos you develop against are the` +
        ` repos tests run against. Nothing to register.\n`,
    );
    for (const r of plan.repos) {
      console.log(
        `    ${r.name.padEnd(20)} ${r.managed ? "managed" : "dev-managed"}`,
      );
    }
    console.log(
      "\n  Flip any repo between managed and dev-managed in the web UX" +
        `\n  (or \`${product().cli} use-local <repo>\`); tests pick the change up automatically.` +
        "\n  Sibling-path registration for hosted setups: make register-repos args=--legacy\n",
    );
    return;
  }

  if (plan.mode === "defaults") {
    console.log(`\n  ${product().cli} · Test repo sources\n`);
    console.log(
      "  Local Dev is enabled but no workspace exists yet. Your first" +
        ` \`${product().cli}\` command\n  seeds the default workspace with every standard` +
        ` system repo, all managed\n  out of the box (${plural(plan.repos.length, "repo")}):\n`,
    );
    console.log(`    ${plan.repos.join(", ")}\n`);
    console.log(
      "  Test discovery follows that workspace automatically — nothing to register.\n",
    );
    return;
  }

  await legacyScanAndSelect();
}

// Direct-run guard: jest imports this module for planRegistration — only run
// the CLI when executed as a script (jest's argv[1] is the jest binary).
const isDirectRun = Boolean(
  process.argv[1] && /register-repos\.(ts|js)$/.test(process.argv[1]),
);
if (isDirectRun) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
