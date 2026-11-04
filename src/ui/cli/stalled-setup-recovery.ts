/**
 * Recovery flow for a hidden `make setup` that stalled on an interactive
 * prompt during `den up` (the stall guard killed it and reported the
 * prompt line). Setups run one at a time in the foreground, so the terminal
 * is free — offer to re-run right here instead of sending the user off to
 * run it themselves and re-run `den up`.
 *
 * Extracted from DenCLI.ensureManagedClonesFor so the four routes
 * (accept+success / accept+failure / decline-or-timeout / non-interactive)
 * are unit-testable — index.ts self-executes at module scope.
 */

import chalk from "chalk";
import inquirer from "inquirer";

import { product } from "../../shared/product.js";
/** Auto-decline the offer after this long: `up` must never hang unattended. */
export const STALLED_SETUP_CONFIRM_TIMEOUT_MS = 60_000;

/**
 * Confirm with an auto-answer timeout. A TTY with nobody watching (ssh -t
 * automation, tmux left running) must never hang the caller at a prompt —
 * after `timeoutMs` the prompt is closed and `timeoutValue` returned.
 *
 * (Lives here rather than in CLIPrompts because prompts.ts uses
 * import.meta.url and can't be loaded under jest's CJS transform.)
 */
export async function confirmWithTimeout(
  message: string,
  timeoutMs: number,
  defaultValue: boolean = true,
  timeoutValue: boolean = false,
): Promise<boolean> {
  const prompt = inquirer.prompt<{ confirmed: boolean }>([
    {
      type: "confirm",
      name: "confirmed",
      message,
      default: defaultValue,
    },
  ]);
  // A dead stdin (Ctrl+D, closed pipe) can REJECT the prompt — or leave it
  // pending forever and make ui.close() throw ERR_USE_AFTER_CLOSE once the
  // timer fires. Route every no-answer path to `timeoutValue`; never let a
  // prompt failure crash the caller (`den up`).
  const answered = prompt.then(
    (a) => a,
    () => null,
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  try {
    const result = await Promise.race([answered, timedOut]);
    if (result === null) {
      try {
        // release stdin — an unanswered prompt must not hold the process.
        // `close` is typed protected on inquirer's UI class but is the
        // documented way to abandon a pending prompt.
        (prompt.ui as unknown as { close(): void }).close();
      } catch {
        /* readline already closed (EOF) */
      }
      return timeoutValue;
    }
    return result.confirmed;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface StalledSetupDeps {
  /** Is a human plausibly attached? (stdin AND stdout are TTYs) */
  isInteractive: () => boolean;
  /** Timeout-capable confirm — must resolve false when nobody answers. */
  confirm: (message: string) => Promise<boolean>;
  /** Re-run the repo's setup with inherited stdio; resolves its exit code. */
  runSetupInteractive: (repoPath: string) => Promise<number>;
  /** Record the setup-success marker so `den up` won't re-run it. */
  markSetupSucceeded: (repoPath: string) => void;
  log: (line: string) => void;
}

/**
 * Show the stalled prompt and, when a human is attached, offer an in-terminal
 * re-run. Returns true iff setup was recovered (re-run succeeded) — the
 * caller must mark the repo failed otherwise.
 */
export async function recoverStalledSetup(
  repoName: string,
  repoPath: string,
  stalledPrompt: string,
  deps: StalledSetupDeps,
): Promise<boolean> {
  deps.log(
    chalk.yellow(`\n  It stopped at a prompt ${product().cli} can't answer:`),
  );
  deps.log(chalk.gray(`  │ ${stalledPrompt}`));

  if (
    deps.isInteractive() &&
    (await deps.confirm(`Run setup for ${repoName} interactively now?`))
  ) {
    deps.log(chalk.cyan(`\n  ── setup ${repoName} (interactive) ──`));
    const code = await deps.runSetupInteractive(repoPath);
    if (code === 0) {
      deps.markSetupSucceeded(repoPath);
      deps.log(chalk.green(`\n  ✓ setup ${chalk.bold(repoName)}\n`));
      return true;
    }
    deps.log(chalk.red(`\n  ✗ setup ${repoName} failed (exit ${code})`));
    deps.log(
      chalk.yellow(
        `  Fix setup in ${repoPath}, then re-run \`${product().cli} up\` ` +
          `(or \`${product().cli} setup ${repoName}\`).\n`,
      ),
    );
    return false;
  }

  deps.log(
    chalk.yellow(
      `  Run it yourself once — \`cd ${repoPath} && make setup\` ` +
        `(or \`${product().cli} setup ${repoName}\`) — then re-run \`${product().cli} up\`.\n`,
    ),
  );
  return false;
}
