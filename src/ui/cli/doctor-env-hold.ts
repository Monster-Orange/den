import { spawnSync } from "child_process";
import {
  holdOutcome,
  type EnvHoldSettings,
} from "../../shared/agents/env-hold.js";
import { agentsCount } from "../../shared/agents/env-hold-rollout.js";

export function shellEnvNames(env: NodeJS.ProcessEnv = process.env): string[] {
  const names = new Set(Object.keys(env).filter((k) => env[k] !== undefined));
  const shell = env.SHELL;
  if (shell && shell.startsWith("/")) {
    const r = spawnSync(shell, ["-c", "env"], {
      encoding: "utf-8",
      timeout: 3000,
      env: { PATH: env.PATH ?? "/usr/bin:/bin", HOME: env.HOME ?? "" },
    });
    if (r.status === 0)
      for (const line of (r.stdout ?? "").split("\n")) {
        const m = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(line);
        if (m) names.add(m[1]);
      }
  }
  return [...names];
}

export const SHELL_LAYER_RUNTIMES = ["den-claude"];

export function envHoldLines(
  title: string,
  s: EnvHoldSettings,
  names: readonly string[],
  legacy: readonly { id: string; names: string[] }[] = [],
): { lines: string[]; problem: boolean } {
  const lines = ["", `${title} doctor: secrets held out of agents`, ""];
  if (!s.hold.length && !s.holdSet)
    lines.push(
      "  env hold  ℹ  off on a personal install: nothing is held back (set agents.env_hold, or install_mode: strict, to hold secret-looking variables back)",
    );
  else if (!s.hold.length)
    lines.push(
      "  env hold  ⚠  secret list is empty: nothing is held back (agents.env_hold: [])",
    );
  else {
    const { held, allowed } = holdOutcome(names, s.hold, s.allowAll);
    lines.push(
      `  env hold  ✓  ${s.holdSet ? "agents.env_hold" : "default list"}: ${s.hold.join(", ")}`,
    );
    lines.push(
      held.length
        ? `  env hold  ✓  held back: ${held.join(", ")}`
        : "  env hold  ✓  held back: none here now",
    );
    if (allowed.length)
      lines.push(
        `  env hold  ℹ  every agent: let through: ${allowed.join(", ")} (agents.env_allow)`,
      );
    for (const id of Object.keys(s.allow).sort()) {
      const r = holdOutcome(names, s.hold, s.allow[id]);
      if (r.allowed.length)
        lines.push(
          `  env hold  ℹ  ${id}: let through: ${r.allowed.join(", ")} (agents.env_allow_agents)`,
        );
    }
    lines.push(
      `  env hold  ℹ  shell commands hold them back for ${SHELL_LAYER_RUNTIMES.join(", ")}; other runtimes hold them back only from what the agent starts with`,
    );
    if (legacy.length) {
      lines.push(
        `  env hold  ⚠  ${agentsCount(legacy.length)} started before the hold still get them: Allow Keep these or Remove in the bell`,
      );
      for (const r of legacy)
        lines.push(
          `  env hold  ⚠    ${r.id}: ${r.names.length ? r.names.join(", ") : "none here now"}`,
        );
    }
  }
  lines.push(
    s.guard
      ? "  env guard ✓  env, printenv, set and the like show secret-looking values masked (against printing by accident, not a boundary: a held name never reaches the agent at all)"
      : "  env guard ⚠  agents.env_guard is false: env, printenv and set print secret-looking values as they are",
  );
  return { lines, problem: false };
}
