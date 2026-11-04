/**
 * `den apps` (alias `applications`): Org > Application > Repo > Services
 * for the focused workspace, and the `-A/--app <name>` flag for up/down/
 * restart/status.
 */
import chalk from "chalk";
import {
  loadApplications,
  loadApplicationTree,
} from "../../shared/environment-manager/load-applications.js";
import type {
  Application,
  ApplicationContributor,
} from "../../shared/applications.js";

import { product } from "../../shared/product.js";
import type {
  Placement,
  RollupPlacement,
} from "../../shared/manifest/placement.js";

/** An application's placement line: "⇄ hybrid: <summary>", "☁ remote", or "". */
export function describeAppPlacement(a: {
  placement: RollupPlacement;
  summary: string;
}): string {
  if (a.placement === "hybrid") return `⇄ hybrid: ${a.summary}`;
  if (a.placement === "remote") return "☁ remote";
  return "";
}

/** A repo's suffix over its services: "☁ remote (dev)", "⇄ hybrid", or "". */
export function describeRepoPlacement(services: Placement[]): string {
  const runs = new Set(services.map((s) => s.runs).filter((r) => r !== "none"));
  if (runs.size > 1) return "⇄ hybrid";
  if (!runs.has("remote")) return "";
  const envs = [
    ...new Set(services.flatMap((s) => (s.target ? [s.target.env] : []))),
  ].sort();
  return `☁ remote (${envs.join(", ")})`;
}
/** "feature-items (module) → ships in core-api" */
export function describeContributor(c: ApplicationContributor): string {
  return `${c.repo} (${c.kind}) → ${c.contributesTo.length ? `ships in ${c.contributesTo.join(", ")}` : "no consumer known"}`;
}

/** Pull `-A <name>` / `--app <name>` / `--app=<name>` out of args. */
export function takeAppFlag(args: string[]): {
  app?: string;
  rest: string[];
} {
  const rest: string[] = [];
  let app: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-A" || a === "--app") {
      app = args[++i];
      if (!app || app.startsWith("-"))
        throw new Error(
          `${a} needs an application name (see \`${product().cli} apps\`)`,
        );
    } else if (a.startsWith("--app=")) app = a.slice("--app=".length);
    else rest.push(a);
  }
  return { app, rest };
}

/** The runtime repos of application `name`; throws if unknown or empty. */
export function appRepos(apps: Application[], name: string): Set<string> {
  const a = apps.find((x) => x.name === name);
  if (!a)
    throw new Error(
      `No application "${name}". Applications here: ${apps.map((x) => x.name).join(", ") || "none"}`,
    );
  if (a.repos.length === 0)
    throw new Error(
      a.contributors.length
        ? `Application "${name}" has no runtime here, only modules/libraries: ${a.contributors.map((c) => c.repo).join(", ")}`
        : `Application "${name}" has no repos in this workspace`,
    );
  return new Set(a.repos);
}

/** appRepos over the focused workspace. */
export function focusedAppRepos(name: string): Set<string> {
  return appRepos(loadApplications(), name);
}

export function cmdApps(args: string[]): void {
  if (args.includes("-h") || args.includes("--help")) {
    console.log(
      `\n  ${product().cli} apps [--json]        (alias: applications)\n\n` +
        "  Org > Application > Repo > Services for the focused workspace.\n" +
        `  Applications come from \`applications:\` in ${product().configFile} and\n` +
        `  \`application:\` in a repo's ${product().manifestYml} (the repo wins). Any other\n` +
        "  repo is its own application, named after the repo.\n" +
        `  Act on one with -A: ${product().cli} up -A <app>.\n`,
    );
    return;
  }
  const tree = loadApplicationTree();
  if (args.includes("--json")) {
    console.log(JSON.stringify(tree, null, 2));
    return;
  }
  console.log();
  console.log(
    `  ${chalk.bold(tree.org?.title ?? "Org")}${tree.org && tree.org.id !== tree.org.title ? chalk.gray(`  (${tree.org.id})`) : ""}`,
  );
  if (tree.applications.length === 0) {
    console.log(chalk.yellow("    No repos in this workspace.\n"));
    return;
  }
  for (const a of tree.applications) {
    console.log();
    const title = a.title !== a.name ? `  ${a.title}` : "";
    const owner = a.owner ? chalk.gray(`  · ${a.owner}`) : "";
    const kind =
      a.source === "repo" ? chalk.gray("  (repo is the application)") : "";
    const placed = describeAppPlacement(a);
    console.log(
      `    ${chalk.bold.cyan(a.name)}${title}${owner}${kind}${placed ? chalk.cyan(`  ${placed}`) : ""}`,
    );
    if (a.description) console.log(chalk.gray(`      ${a.description}`));
    const width = Math.max(0, ...a.repos.map((r) => r.length));
    for (const repo of a.repos) {
      const subs = a.services[repo]
        .map((addr) => (addr.includes("/") ? addr.split("/")[1] : addr))
        .filter((s) => s !== repo);
      const where = describeRepoPlacement(
        a.services[repo].flatMap((addr) => a.placements[addr] ?? []),
      );
      const suffix = where ? chalk.cyan(`  ${where}`) : "";
      console.log(
        `      ${subs.length ? `${repo.padEnd(width)}${chalk.gray(`  ${subs.join(", ")}`)}` : repo}${suffix}`,
      );
    }
    for (const c of a.contributors)
      console.log(chalk.gray(`      ${describeContributor(c)}`));
    if (a.absent.length)
      console.log(
        chalk.gray(`      not in this workspace: ${a.absent.join(", ")}`),
      );
    if (!a.repos.length && !a.contributors.length && !a.absent.length)
      console.log(chalk.gray("      (no repos in this workspace)"));
  }
  console.log();
}
