/**
 * CLI Prompts
 * Interactive prompts for user input
 */

import inquirer from "inquirer";
import chalk from "chalk";
import * as fs from "fs/promises";
import { existsSync, type Dirent } from "fs";
import * as path from "path";
import type { Environment, Pillar } from "../../shared/types/index.js";
import { getReposRoot } from "../../shared/den-config.js";
import { envSelector } from "../../shared/environment/env-selector.js";
import { moduleScanner } from "../../shared/test-discovery/module-scanner.js";
import * as yaml from "yaml";
import { readManifestAsync } from "../../shared/manifest/read-manifest.js";

import { product } from "../../shared/product.js";
import { getDistRoot } from "../../shared/paths.js";
// Linked repos (.<name>/<repo>) live at the distribution root, wherever the
// CLI was launched from.
const linkedRepo = (...parts: string[]): string =>
  path.join(getDistRoot(), `.${product().name}`, ...parts);

export class CLIPrompts {
  /**
   * Prompt for environment selection
   */
  async promptForEnvironment(): Promise<Environment> {
    const availableEnvs = await envSelector.getAvailableEnvironments();

    const { environment } = await inquirer.prompt<{ environment: Environment }>(
      [
        {
          type: "list",
          name: "environment",
          message: "Select environment:",
          choices: availableEnvs.map((env) => ({
            name: this.formatEnvironmentName(env),
            value: env,
          })),
        },
      ],
    );

    return environment;
  }

  /**
   * Prompt for test pillar selection
   */
  async promptForPillar(): Promise<Pillar> {
    const { pillar } = await inquirer.prompt<{ pillar: Pillar }>([
      {
        type: "list",
        name: "pillar",
        message: "Select test pillar:",
        choices: [
          {
            name: "🌐 Synthetic (Browser Tests)",
            value: "synthetic",
          },
          {
            name: "🔗 Integration (API Tests)",
            value: "integration",
          },
          {
            name: "💨 Smoke (Service-Owned Tests)",
            value: "smoke",
          },
          {
            name: "⚡ Performance (Load Tests)",
            value: "performance",
          },
          {
            name: "🧭 Journeys (Agent E2E)",
            value: "journeys",
          },
          {
            name: "🛡 Security (OWASP ZAP)",
            value: "security",
          },
          {
            name: "🧪 Suites (repo-owned tests)",
            value: "suites",
          },
        ],
      },
    ]);

    return pillar;
  }

  /**
   * Prompt for test module selection (works for all pillars)
   * Auto-discovers modules from filesystem
   */
  async promptForModule(pillar: Pillar): Promise<string | null | "back"> {
    // Scan for available modules
    const modules = await moduleScanner.scanModules(pillar);

    // Pillar-specific labels
    const labels: Record<Pillar, { all: string; message: string }> = {
      synthetic: {
        all: "🎯 All Modules (complete test suite)",
        message: "Select test module:",
      },
      integration: {
        all: "🎯 All APIs (complete test suite)",
        message: "Select API module:",
      },
      smoke: {
        all: "🎯 All Services (complete smoke suite)",
        message: "Select service:",
      },
      performance: {
        all: "🎯 All Performance Tests (complete suite)",
        message: "Select performance test:",
      },
      journeys: {
        all: "🎯 All Journeys (complete suite)",
        message: "Select journey:",
      },
      security: {
        all: "🎯 All Security Targets (baseline scans)",
        message: "Select security target:",
      },
      suites: {
        all: "🎯 Every repo suite",
        message: "Select suite:",
      },
    };

    // Build choices dynamically
    const choices: Array<
      | { name: string; value: string | null }
      | InstanceType<typeof inquirer.Separator>
    > = [
      {
        name: labels[pillar].all,
        value: "all",
      },
      {
        name: "⬅️  Back to pillar selection",
        value: "back",
      },
      new inquirer.Separator("━".repeat(40)),
    ];

    // Add discovered modules (show count and tags)
    for (const module of modules) {
      // For performance/journeys/security: no count (a journeys module IS
      // one journey; a security module IS one scan target). For smoke: count files not test cases.
      const unit = pillar === "smoke" ? "file" : "test";
      const countStr =
        pillar === "performance" ||
        pillar === "journeys" ||
        pillar === "security"
          ? ""
          : module.testCount === 0
            ? chalk.gray(`(0 ${unit}s)`)
            : chalk.cyan(
                `(${module.testCount} ${unit}${module.testCount > 1 ? "s" : ""})`,
              );

      // Show tags if present
      const tagsStr =
        module.tags.length > 0
          ? chalk.gray(` [${module.tags.join(", ")}]`)
          : "";

      choices.push({
        name: `${module.icon} ${module.displayName} ${countStr}${tagsStr} - ${module.description}`,
        value: module.name,
      });
    }

    const { module } = await inquirer.prompt<{ module: string }>([
      {
        type: "list",
        name: "module",
        message: labels[pillar].message,
        choices,
      },
    ]);

    if (module === "back") return "back";
    return module === "all" ? null : module;
  }

  /**
   * Prompt for a smoke collection (suite) within a service
   * moduleName format: "shop/api"
   */
  async promptForSmokeCollection(
    moduleName: string,
  ): Promise<string | null | "back"> {
    const [repo, service] = moduleName.split("/");

    let testDir = "";
    try {
      const manifest = await readManifestAsync(linkedRepo(repo));
      testDir = (manifest as Record<string, unknown> | null)
        ? ((manifest as { smoke?: Record<string, { testDir?: string }> })
            .smoke?.[service]?.testDir ?? "")
        : "";
    } catch {
      // manifest unreadable — fall through with empty testDir
    }

    const collectionsDir = linkedRepo(repo, testDir);

    // Discover collection subdirectories
    const collections: Array<{
      name: string;
      icon: string;
      displayName: string;
      testCount: number;
    }> = [];
    try {
      const entries = await fs.readdir(collectionsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name.startsWith("_") || entry.name.startsWith(".")) continue;

        // Count .smoke.ts files in this collection
        let testCount = 0;
        try {
          const files = await fs.readdir(path.join(collectionsDir, entry.name));
          testCount = files.filter((f) => f.endsWith(".smoke.ts")).length;
        } catch {
          /* ignore */
        }

        // Load manifest.yml for icon/name
        let icon = "📦";
        let displayName = entry.name;
        try {
          const mYaml = await fs.readFile(
            path.join(collectionsDir, entry.name, "manifest.yml"),
            "utf-8",
          );
          const m = yaml.parse(mYaml);
          if (m?.icon) icon = m.icon;
          if (m?.name) displayName = m.name;
        } catch {
          /* no manifest */
        }

        collections.push({ name: entry.name, icon, displayName, testCount });
      }
    } catch {
      /* dir unreadable */
    }

    collections.sort((a, b) => a.name.localeCompare(b.name));

    const choices: Array<
      | { name: string; value: string | null }
      | InstanceType<typeof inquirer.Separator>
    > = [
      { name: `🎯 All collections in ${service}`, value: null },
      { name: "⬅️  Back to service selection", value: "back" },
      new inquirer.Separator("━".repeat(40)),
    ];

    for (const col of collections) {
      const countStr =
        col.testCount === 0
          ? chalk.gray("(0 files)")
          : chalk.cyan(
              `(${col.testCount} file${col.testCount !== 1 ? "s" : ""})`,
            );
      choices.push({
        name: `${col.icon} ${col.displayName} ${countStr}`,
        value: col.name,
      });
    }

    const { collection } = await inquirer.prompt<{ collection: string | null }>(
      [
        {
          type: "list",
          name: "collection",
          message: `Select collection in ${repo}/${service}:`,
          choices,
        },
      ],
    );

    return collection === "back" ? "back" : collection;
  }

  /**
   * Prompt for credentials setup
   */
  async promptForCredentials(environment: Environment): Promise<{
    username: string;
    password: string;
    auth0ClientId?: string;
  }> {
    console.log(
      `\n🔐 Setup credentials for: ${this.formatEnvironmentName(environment)}`,
    );
    console.log("━".repeat(50));

    const answers = await inquirer.prompt([
      {
        type: "input",
        name: "username",
        message: "Username/Email:",
        validate: (input: string) => {
          if (!input || input.trim().length === 0) {
            return "Username is required";
          }
          return true;
        },
      },
      {
        type: "password",
        name: "password",
        message: "Password:",
        mask: "*",
        validate: (input: string) => {
          if (!input || input.trim().length === 0) {
            return "Password is required";
          }
          return true;
        },
      },
      {
        type: "input",
        name: "auth0ClientId",
        message: "Auth0 Client ID (optional):",
      },
    ]);

    return answers;
  }

  /**
   * Prompt for elevated credentials
   */
  async promptForElevatedCredentials(environment: Environment): Promise<{
    username: string;
    password: string;
  } | null> {
    const { needElevated } = await inquirer.prompt<{ needElevated: boolean }>([
      {
        type: "confirm",
        name: "needElevated",
        message: "Setup elevated/admin credentials?",
        default: false,
      },
    ]);

    if (!needElevated) {
      return null;
    }

    console.log(
      `\n🔑 Setup elevated credentials for: ${this.formatEnvironmentName(environment)}`,
    );
    console.log("━".repeat(50));

    const answers = await inquirer.prompt([
      {
        type: "input",
        name: "username",
        message: "Admin Username/Email:",
        validate: (input: string) => {
          if (!input || input.trim().length === 0) {
            return "Username is required";
          }
          return true;
        },
      },
      {
        type: "password",
        name: "password",
        message: "Admin Password:",
        mask: "*",
        validate: (input: string) => {
          if (!input || input.trim().length === 0) {
            return "Password is required";
          }
          return true;
        },
      },
    ]);

    return answers;
  }

  /**
   * Confirm action
   */
  async confirm(
    message: string,
    defaultValue: boolean = true,
  ): Promise<boolean> {
    const { confirmed } = await inquirer.prompt<{ confirmed: boolean }>([
      {
        type: "confirm",
        name: "confirmed",
        message,
        default: defaultValue,
      },
    ]);

    return confirmed;
  }

  /**
   * Prompt for main menu action
   */
  async promptForMainAction(): Promise<
    "run" | "results" | "environment" | "exit"
  > {
    const { action } = await inquirer.prompt<{
      action: "run" | "results" | "environment" | "exit";
    }>([
      {
        type: "list",
        name: "action",
        message: "What would you like to do?",
        choices: [
          {
            name: "▶️  Run Tests",
            value: "run",
          },
          {
            name: "📊 View Results",
            value: "results",
          },
          {
            name: "❌ Exit",
            value: "exit",
          },
        ],
      },
    ]);

    return action;
  }

  /**
   * Prompt for number of days for results
   */
  async promptForResultsDays(): Promise<number> {
    const { days } = await inquirer.prompt<{ days: string }>([
      {
        type: "list",
        name: "days",
        message: "Show results from:",
        choices: [
          { name: "Last 24 hours", value: "1" },
          { name: "Last 7 days", value: "7" },
          { name: "Last 30 days", value: "30" },
          { name: "All time", value: "365" },
        ],
      },
    ]);

    return parseInt(days, 10);
  }

  async promptForWorkspaceAction(): Promise<
    | "list"
    | "use"
    | "create"
    | "add-service"
    | "remove-service"
    | "delete"
    | "back"
  > {
    const { action } = await inquirer.prompt<{
      action:
        | "list"
        | "use"
        | "create"
        | "add-service"
        | "remove-service"
        | "delete"
        | "back";
    }>([
      {
        type: "list",
        name: "action",
        message: "Workspaces:",
        choices: [
          { name: "📋 List Workspaces", value: "list" },
          { name: "🔀 Switch Workspace", value: "use" },
          { name: "➕ Create Workspace", value: "create" },
          { name: "➕ Add Service to Workspace", value: "add-service" },
          { name: "➖ Remove Service from Workspace", value: "remove-service" },
          { name: "🗑  Delete Workspace", value: "delete" },
          { name: "← Back", value: "back" },
        ],
      },
    ]);
    return action;
  }

  async promptForRegistrationSource(): Promise<"local" | "github"> {
    const { source } = await inquirer.prompt<{ source: "local" | "github" }>([
      {
        type: "list",
        name: "source",
        message: "Where is this repo?",
        choices: [
          {
            name: `Local checkout  — I already have it on disk (${product().cli} reads it, never modifies)`,
            value: "local",
          },
          {
            name: `GitHub repo     — ${product().cli} clones and manages it for me`,
            value: "github",
          },
        ],
      },
    ]);
    return source;
  }

  async promptForGhOrgRepo(
    repos: { name: string; nameWithOwner: string; defaultBranch: string }[],
  ): Promise<{ name: string; nameWithOwner: string; defaultBranch: string }> {
    const { selected } = await inquirer.prompt<{ selected: string }>([
      {
        type: "list",
        name: "selected",
        message: "Select GitHub repo:",
        choices: repos.map((r) => ({
          name: r.nameWithOwner,
          value: r.nameWithOwner,
        })),
        pageSize: 20,
      },
    ]);
    return repos.find((r) => r.nameWithOwner === selected)!;
  }

  async promptForRepoPath(alreadyRegistered: string[] = []): Promise<string> {
    const reposRoot = getReposRoot();
    const MANUAL_ENTRY = "__manual__";

    // Recursively discover repos under reposRoot (dirs with .den.yml), up to depth 4.
    type RepoCandidate = {
      relPath: string;
      absPath: string;
      registered: boolean;
    };
    const candidates: RepoCandidate[] = [];

    const walkDir = async (
      dir: string,
      relPrefix: string,
      depth: number,
    ): Promise<void> => {
      if (depth > 4) return;
      let entries: Dirent[];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      await Promise.all(
        entries.map(async (e) => {
          if (!e.isDirectory() && !e.isSymbolicLink()) return;
          if (e.name.startsWith(".")) return;
          const absPath = path.join(dir, e.name);
          if (absPath === getDistRoot()) return; // skip this distribution itself
          const relPath = relPrefix ? `${relPrefix}/${e.name}` : e.name;
          const hasManifest = await fs
            .access(path.join(absPath, `${product().manifestYml}`))
            .then(() => true)
            .catch(() => false);
          if (hasManifest) {
            candidates.push({
              relPath,
              absPath,
              registered: alreadyRegistered.includes(relPath),
            });
          } else {
            await walkDir(absPath, relPath, depth + 1);
          }
        }),
      );
    };
    await walkDir(reposRoot, "", 0);

    const choices: { name: string; value: string }[] = candidates
      .sort((a, b) => a.relPath.localeCompare(b.relPath))
      .map((c) => {
        const reg = c.registered ? chalk.gray(" (already registered)") : "";
        return { name: `${chalk.green(c.relPath)}${reg}`, value: c.absPath };
      });

    choices.push({
      name: chalk.gray("Enter path manually…"),
      value: MANUAL_ENTRY,
    });

    const { selected } = await inquirer.prompt<{ selected: string }>([
      {
        type: "list",
        name: "selected",
        message: "Select repo:",
        choices,
        pageSize: 15,
      },
    ]);

    if (selected !== MANUAL_ENTRY) return selected;

    const { repoPath } = await inquirer.prompt<{ repoPath: string }>([
      {
        type: "input",
        name: "repoPath",
        message: "Absolute path to repo checkout:",
        validate: (v: string) => {
          const p = v.trim();
          if (!p) return "Path is required";
          if (!existsSync(p)) return `Path does not exist: ${p}`;
          return true;
        },
      },
    ]);
    return repoPath.trim();
  }

  async promptForBranch(defaultValue = "main"): Promise<string> {
    const { branch } = await inquirer.prompt<{ branch: string }>([
      {
        type: "input",
        name: "branch",
        message: `Branch to track (${product().cli} will clone/pull this branch):`,
        default: defaultValue,
        validate: (v: string) => (v.trim() ? true : "Branch name is required"),
      },
    ]);
    return branch.trim();
  }

  async promptForLinkedPath(defaultPath: string): Promise<string> {
    const { confirmed } = await inquirer.prompt<{ confirmed: boolean }>([
      {
        type: "confirm",
        name: "confirmed",
        message: `Use this path for the linked checkout?\n    ${defaultPath}`,
        default: true,
      },
    ]);
    if (confirmed) return defaultPath;

    const { p } = await inquirer.prompt<{ p: string }>([
      {
        type: "input",
        name: "p",
        message: "Absolute path to your local checkout:",
        validate: (v: string) => {
          const trimmed = v.trim();
          if (!trimmed) return "Path is required";
          if (!existsSync(trimmed)) return `Path does not exist: ${trimmed}`;
          return true;
        },
      },
    ]);
    return p.trim();
  }

  async promptForGhSlug(defaultValue?: string): Promise<string> {
    const { slug } = await inquirer.prompt<{ slug: string }>([
      {
        type: "input",
        name: "slug",
        message: "GitHub repo slug (owner/repo):",
        default: defaultValue,
        validate: (v: string) =>
          /^[\w.-]+\/[\w.-]+$/.test(v.trim())
            ? true
            : "Expected format: owner/repo",
      },
    ]);
    return slug.trim();
  }

  async promptSelectWorkspace(
    workspaces: string[],
    current: string,
  ): Promise<string> {
    const { name } = await inquirer.prompt<{ name: string }>([
      {
        type: "list",
        name: "name",
        message: "Select workspace:",
        choices: workspaces.map((w) => ({
          name: w === current ? `${w} (active)` : w,
          value: w,
        })),
      },
    ]);
    return name;
  }

  async promptForWorkspaceName(existing: string[]): Promise<string> {
    const { name } = await inquirer.prompt<{ name: string }>([
      {
        type: "input",
        name: "name",
        message: "Workspace name:",
        validate: (v: string) => {
          const n = v.trim();
          if (!n) return "Name is required";
          if (existing.includes(n)) return `Workspace "${n}" already exists`;
          // eslint-disable-next-line no-control-regex
          if (/["'\\/<>\x00-\x1f]/.test(n))
            return "Name must not contain quotes, slashes, or control characters";
          return true;
        },
      },
    ]);
    return name.trim();
  }

  async promptSelectServices(
    addresses: string[],
    message: string,
    defaultAll = true,
  ): Promise<string[]> {
    const { selected } = await inquirer.prompt<{ selected: string[] }>([
      {
        type: "checkbox",
        name: "selected",
        message,
        choices: addresses.map((a) => ({
          name: a,
          value: a,
          checked: defaultAll,
        })),
        pageSize: 20,
      },
    ]);
    return selected;
  }

  /**
   * Format environment name for display
   */
  private formatEnvironmentName(env: Environment): string {
    const names: Record<Environment, string> = {
      local: "🏠 Local",
      dev: "🔧 Development",
      sandbox: "🏖️  Sandbox",
      staging: "🎭 Staging",
      beta: "🧪 Beta",
      prod: "🚀 Prod",
      production: "🚀 Production",
    };

    return names[env] || env;
  }
}

// Export singleton instance
export const cliPrompts = new CLIPrompts();
