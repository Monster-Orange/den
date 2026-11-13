/**
 * `stack ls | up <name…> [--build] | down <name…> [--force] | restart <name…> | health <name…> | ps <name> | logs <name> [args]`
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
import {
  loadStackContext,
  rejoinRunningStacks,
  stackStatuses,
} from "../../shared/stacks/status.js";
import {
  assertStackClaim,
  forgetStackOwners,
  recordStackOwner,
  releaseStackOwner,
  stackRefcounted,
} from "../../shared/stacks/owners.js";
import { resolveStackNamespace } from "../../shared/stacks/namespace.js";
import type { StackConfig } from "../../shared/stacks/types.js";
import { STACK_HEALTH_UNKNOWN_EXIT } from "../../shared/constants.js";

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

/**
 * `stack health <name…>`: exit 0 when every stack is healthy, 1 when one is
 * not, and STACK_HEALTH_UNKNOWN_EXIT when none failed but one could not be
 * told (docker did not answer, the config could not be read). The web
 * server's health row reads that as unknown, never as down.
 */
function stackHealthCommand(args: string[], service?: string): void {
  let failed = false;
  let unknown = false;
  try {
    const ctx = loadStackContext();
    const names = args.filter((a) => !a.startsWith("-"));
    if (!names.length)
      throw new Error(
        `Usage: stack health <name…>  (known: ${Object.keys(ctx.stacks).join(", ")})`,
      );
    for (const n of names) {
      const s = ctx.stacks[n];
      const h = s
        ? stackHealth(ctx, s, service)
        : { ok: false, detail: `unknown stack "${n}"` };
      if (h.ok === false) failed = true;
      if (h.ok === null) unknown = true;
      const mark =
        h.ok === true
          ? chalk.green("✓")
          : h.ok === false
            ? chalk.red("✗")
            : chalk.gray("?");
      console.log(`${mark} ${n}  ${h.detail}`);
    }
  } catch (e) {
    console.error(chalk.gray(`? ${(e as Error).message}`));
    unknown = true;
  }
  process.exitCode = failed ? 1 : unknown ? STACK_HEALTH_UNKNOWN_EXIT : 0;
}

export async function cmdStack(argv: string[]): Promise<void> {
  const { service, rest } = serviceFlag(argv);
  const [sub = "ls", ...args] = rest;
  if (sub === "health") return stackHealthCommand(args, service);
  // The global -w/--workspace is parsed (and checked) before we run and
  // arrives as DEN_WORKSPACE_OVERRIDE; loadStackContext reads it.
  const ctx = loadStackContext();
  const { edge, stacks } = ctx;
  const names = args.filter((a) => !a.startsWith("-"));
  // workspaces.yml overriding a different blueprint stack_namespace.
  if (ctx.denWorkspace && ctx.namespaceSource === "workspace")
    for (const w of resolveStackNamespace(ctx.denWorkspace).warnings)
      console.error(chalk.yellow(`⚠ ${w}`));
  /** Each stack's other live owners; throws on a checkout mismatch. */
  const claims = (targets: string[]): Map<string, string[]> => {
    const out = new Map<string, string[]>();
    if (!stackRefcounted(ctx)) return out;
    for (const n of targets)
      if (stacks[n])
        out.set(n, assertStackClaim(ctx, stacks[n], ctx.denWorkspace));
    return out;
  };
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
      // A shared namespace: refused before anything starts when another
      // workspace runs one of these projects from a different checkout.
      const shared = claims(order);
      await edgeUp(edge);
      rejoinRunningStacks();
      for (const n of order) {
        console.log(chalk.cyan(`\n▶ ${n} (${projectName(n, ctx.workspace)})`));
        if (shared.get(n)?.length)
          console.log(
            chalk.gray(
              `  shared with [${shared.get(n)!.join(", ")}] (stack namespace ${ctx.workspace})`,
            ),
          );
        stackUp(ctx, stacks[n], {
          build: args.includes("--build"),
          secretEnv: secrets.get(n),
        });
        if (stackRefcounted(ctx))
          recordStackOwner(ctx, stacks[n], ctx.denWorkspace);
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
      const shared = claims(pick());
      await edgeUp(edge);
      rejoinRunningStacks();
      for (const n of pick()) {
        console.log(chalk.cyan(`↻ ${n}`));
        if (shared.get(n)?.length)
          console.log(
            chalk.yellow(
              `  Warning: restarting a shared stack — this interrupts [${shared.get(n)!.join(", ")}]`,
            ),
          );
        stackDown(ctx, stacks[n]);
        stackUp(ctx, stacks[n], {
          build: args.includes("--build"),
          secretEnv: secrets.get(n),
        });
        if (stackRefcounted(ctx))
          recordStackOwner(ctx, stacks[n], ctx.denWorkspace);
      }
      return;
    }
    case "down":
      for (const n of startOrder(pick(), stacks)
        .reverse()
        .filter((n) => names.includes(n))) {
        // A shared namespace: the last live owner stops it; any other
        // detaches. `--force` stops it whoever else holds it.
        if (stackRefcounted(ctx) && !args.includes("--force")) {
          const r = releaseStackOwner(ctx, stacks[n], ctx.denWorkspace);
          if (!r.stop) {
            console.log(
              chalk.cyan(
                `▼ ${n}: detached project "${ctx.denWorkspace}" — ${projectName(n, ctx.workspace)} still running for [${r.remaining.join(", ")}]`,
              ),
            );
            continue;
          }
        }
        console.log(chalk.cyan(`▼ ${n}`));
        stackDown(ctx, stacks[n]);
        forgetStackOwners(ctx, stacks[n]);
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
