/**
 * Issue 974: doctor's rows on the variables held out of agent sessions.
 * Which names in Den's environment and in a shell's (after the person's
 * profile) are held back, which an agent's opt-in lets through, and when
 * the list is empty or the guard is off. Names only: never a value.
 */
import { spawnSync } from "child_process";
import {
  holdOutcome,
  type EnvHoldSettings,
} from "../../shared/agents/env-hold.js";

/**
 * The names a session's shell starts with: Den's own environment's, and
 * those a non-interactive shell has after the person's profile (zsh reads
 * ~/.zshenv for every shell). Names only; nothing is printed.
 */
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

/** The lines (and onboarding rows) doctor prints for the hold. */
export function envHoldLines(
  title: string,
  s: EnvHoldSettings,
  names: readonly string[],
): { lines: string[] } {
  const lines = ["", `${title} doctor: secrets held out of agent sessions`, ""];
  if (!s.hold.length)
    lines.push(
      "  env hold  ⚠  secret list is empty: nothing is held back (agents.env_hold: [])",
    );
  else {
    const { held } = holdOutcome(names, s.hold);
    lines.push(
      `  env hold  ✓  ${s.holdSet ? "agents.env_hold" : "default list"}: ${s.hold.join(", ")}`,
    );
    lines.push(
      held.length
        ? `  env hold  ✓  held back: ${held.join(", ")}`
        : "  env hold  ✓  held back: none here now",
    );
    for (const id of Object.keys(s.allow).sort()) {
      const { allowed } = holdOutcome(names, s.hold, s.allow[id]);
      if (allowed.length)
        lines.push(
          `  env hold  ℹ  ${id}: let through: ${allowed.join(", ")} (agents.env_allow)`,
        );
    }
  }
  lines.push(
    s.guard
      ? "  env guard ✓  commands that print the whole environment are refused"
      : "  env guard ⚠  agents.env_guard is false: commands that print the whole environment run",
  );
  return { lines };
}
