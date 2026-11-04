/**
 * `stack ls | up <name…> [--build] | down <name…> | restart <name…> | health <name…> | ps <name> | logs <name> [args]`
 *
 * Runs repos' Docker Compose projects with no host ports, each as its own
 * project (`<stack>-<workspace>`), served by the edge at
 * https://<route>.<stack>.<edge.domain>.
 */
import chalk from "chalk";
import { readEdgeConfig } from "../../shared/edge/config.js";
import { routeUrl } from "../../shared/edge/render.js";
import { edgeUp } from "../../shared/edge/runtime.js";
import { readStacks } from "../../shared/stacks/config.js";
import {
  getFocusedWorkspaceName,
  getWorkspaceByName,
} from "../../shared/environment-manager/workspaces.js";
import { stackWorkspace } from "../../shared/stacks/render.js";
import { projectName, startOrder } from "../../shared/stacks/render.js";
import {
  stackDown,
  stackHealth,
  stackLogs,
  stackPs,
  stackUp,
  type StackContext,
} from "../../shared/stacks/runtime.js";

function workspaceFlag(args: string[]): {
  fkWs: string;
  ws: string;
  service?: string;
  rest: string[];
} {
  const rest: string[] = [];
  // The global -w/--workspace is parsed (and checked) before we run and
  // arrives as DEN_WORKSPACE_OVERRIDE.
  const fkWs =
    process.env.DEN_WORKSPACE_OVERRIDE ||
    getFocusedWorkspaceName() ||
    "default";
  let service: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--service") service = args[++i];
    else rest.push(args[i]);
  }
  const ws = process.env.DEN_STACK_WORKSPACE || stackWorkspace(fkWs);
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(ws))
    throw new Error(
      `workspace "${ws}" must be lowercase letters, digits and dashes`,
    );
  return { fkWs, ws, service, rest };
}

export async function cmdStack(argv: string[]): Promise<void> {
  const { fkWs, ws, service, rest } = workspaceFlag(argv);
  const [sub = "ls", ...args] = rest;
  const edge = readEdgeConfig();
  // Repo manifests come from that den workspace's checkouts.
  const stacks = readStacks(undefined, {
    workspace: getWorkspaceByName(fkWs) ? fkWs : undefined,
  });
  const ctx: StackContext = { edge, stacks, workspace: ws };
  const names = args.filter((a) => !a.startsWith("-"));
  const pick = () => {
    if (!names.length)
      throw new Error(
        `Usage: stack ${sub} <name…>  (known: ${Object.keys(stacks).join(", ")})`,
      );
    return names;
  };

  switch (sub) {
    case "ls":
      for (const s of Object.values(stacks)) {
        console.log(
          chalk.bold(`${s.name}`) +
            chalk.gray(
              `  ${s.repo}${s.dir ? `/${s.dir}` : ""}  project ${projectName(s.name, ws)}`,
            ),
        );
        for (const route of Object.keys(s.routes))
          console.log(
            `  ${routeUrl(`${route}.${s.name}`, edge)}  → ${s.routes[route]}`,
          );
        if (s.uses.length)
          console.log(chalk.gray(`  uses ${s.uses.join(", ")}`));
      }
      return;
    case "up": {
      // Re-render the edge so its cert covers every stack, then start the stacks.
      await edgeUp(edge);
      for (const n of startOrder(pick(), stacks)) {
        console.log(chalk.cyan(`\n▶ ${n} (${projectName(n, ws)})`));
        stackUp(ctx, stacks[n], { build: args.includes("--build") });
        for (const route of Object.keys(stacks[n].routes))
          console.log(chalk.green(`  ✓ ${routeUrl(`${route}.${n}`, edge)}`));
      }
      return;
    }
    case "restart":
      await edgeUp(edge);
      for (const n of pick()) {
        console.log(chalk.cyan(`↻ ${n}`));
        stackDown(ctx, stacks[n]);
        stackUp(ctx, stacks[n], { build: args.includes("--build") });
      }
      return;
    case "health": {
      let ok = true;
      for (const n of pick()) {
        const h = stackHealth(ctx, stacks[n], service);
        ok &&= h.ok;
        console.log(
          `${h.ok ? chalk.green("✓") : chalk.red("✗")} ${n}  ${h.detail}`,
        );
      }
      process.exitCode = ok ? 0 : 1;
      return;
    }
    case "down":
      for (const n of startOrder(pick(), stacks)
        .reverse()
        .filter((n) => names.includes(n))) {
        console.log(chalk.cyan(`▼ ${n}`));
        stackDown(ctx, stacks[n]);
      }
      return;
    case "ps":
      for (const n of pick())
        console.log(chalk.bold(n) + "\n" + stackPs(ctx, stacks[n]));
      return;
    case "logs":
      process.exitCode = stackLogs(
        ctx,
        stacks[pick()[0]],
        args.filter((a) => a !== names[0]),
      );
      return;
    default:
      throw new Error(
        `Unknown stack command "${sub}". Use: ls | up | down | restart | health | ps | logs`,
      );
  }
}
