/**
 * `stack ls | up <name…> [--build] | down <name…> | restart <name…> | health <name…> | ps <name> | logs <name> [args]`
 *
 * Runs repos' Docker Compose projects with no host ports, each as its own
 * project (`<stack>-<workspace>`), served by the edge at
 * https://<route>.<stack>.<edge.domain>.
 */
import chalk from "chalk";
import { routeUrl } from "../../shared/edge/render.js";
import { edgeUp } from "../../shared/edge/runtime.js";
import { getSecretsProvider } from "../../shared/secrets/index.js";
import type { SecretsProvider } from "../../shared/secrets/types.js";
import { projectName, startOrder } from "../../shared/stacks/render.js";
import {
  resolveStackSecretEnv,
  stackDown,
  stackHealth,
  stackLogs,
  stackPs,
  stackRestartService,
  stackUp,
} from "../../shared/stacks/runtime.js";
import { loadStackContext, stackStatuses } from "../../shared/stacks/status.js";
import type { StackConfig } from "../../shared/stacks/types.js";

function serviceFlag(args: string[]): { service?: string; rest: string[] } {
  const rest: string[] = [];
  let service: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--service") service = args[++i];
    else rest.push(args[i]);
  }
  return { service, rest };
}

/**
 * Every named stack's `secret_env`, resolved before anything starts or
 * stops: one missing key fails the whole command with nothing changed.
 * The provider is only asked when some stack declares secret_env.
 */
export async function resolveStacksSecretEnv(
  targets: StackConfig[],
  provider: () => SecretsProvider = getSecretsProvider,
): Promise<Map<string, Record<string, string>>> {
  const out = new Map<string, Record<string, string>>();
  const needing = targets.filter((s) => Object.keys(s.secretEnv ?? {}).length);
  if (!needing.length) return out;
  const p = provider();
  const failures: string[] = [];
  for (const s of needing) {
    const r = await resolveStackSecretEnv(s, p);
    if (r.ok) out.set(s.name, r.env);
    else failures.push(r.message);
  }
  if (failures.length) throw new Error(failures.join("\n"));
  return out;
}

export async function cmdStack(argv: string[]): Promise<void> {
  const { service, rest } = serviceFlag(argv);
  const [sub = "ls", ...args] = rest;
  // The global -w/--workspace is parsed (and checked) before we run and
  // arrives as DEN_WORKSPACE_OVERRIDE; loadStackContext reads it.
  const ctx = loadStackContext();
  const { edge, stacks } = ctx;
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
      for (const s of stackStatuses(ctx)) {
        console.log(
          chalk.bold(`${s.name}`) +
            chalk.gray(
              `  ${s.repo}${s.dir ? `/${s.dir}` : ""}  project ${s.project}`,
            ),
        );
        for (const route of s.routes)
          console.log(`  ${route.url}  → ${route.target}`);
        if (s.uses.length)
          console.log(chalk.gray(`  uses ${s.uses.join(", ")}`));
      }
      return;
    case "up": {
      // Re-render the edge so its cert covers every stack, then start the stacks.
      const order = startOrder(pick(), stacks);
      const secrets = await resolveStacksSecretEnv(order.map((n) => stacks[n]));
      await edgeUp(edge);
      for (const n of order) {
        console.log(chalk.cyan(`\n▶ ${n} (${projectName(n, ctx.workspace)})`));
        stackUp(ctx, stacks[n], {
          build: args.includes("--build"),
          secretEnv: secrets.get(n),
        });
        for (const route of Object.keys(stacks[n].routes))
          console.log(chalk.green(`  ✓ ${routeUrl(`${route}.${n}`, edge)}`));
      }
      return;
    }
    case "restart": {
      // Resolved before the down: a missing secret leaves the stack running.
      const secrets = await resolveStacksSecretEnv(
        pick().map((n) => stacks[n]),
      );
      if (service) {
        // One compose service, in place: no edge re-render, no recreate.
        for (const n of pick()) {
          console.log(chalk.cyan(`↻ ${n} ${service}`));
          stackRestartService(ctx, stacks[n], service, {
            secretEnv: secrets.get(n),
          });
        }
        return;
      }
      await edgeUp(edge);
      for (const n of pick()) {
        console.log(chalk.cyan(`↻ ${n}`));
        stackDown(ctx, stacks[n]);
        stackUp(ctx, stacks[n], {
          build: args.includes("--build"),
          secretEnv: secrets.get(n),
        });
      }
      return;
    }
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
