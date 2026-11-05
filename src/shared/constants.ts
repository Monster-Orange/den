/**
 * Shared constants — single source of truth for values used across modules.
 *
 * If a value appears in 2+ files, it belongs here.
 * If it's specific to one module (e.g. a Playwright config timeout), keep it local.
 */

import { envKey } from "./product.js";
// ── 1Password strategy (only used when secrets.provider: 1password) ──────────────────────────────────────────────────────────────

/**
 * Default 1Password account domain used by every `op` invocation across den.
 * Kept in sync with the `OP_ACCOUNT ?= …` default in the Makefile. Scripts that
 * may run outside `make` (setup-1password, auth-configure)
 * set `process.env.OP_ACCOUNT ||= OP_ACCOUNT_DEFAULT` at entry so op picks up
 * the right account even when invoked directly via `npx tsx`.
 */
export const OP_ACCOUNT_DEFAULT = "example.1password.com";

/**
 * Default vault for shared test accounts. Deprecated: the vault is org data —
 * read it with testAccountsVault() (src/shared/auth/test-accounts.ts), which
 * honours `test_accounts.vault` in the org config and falls back to this.
 */
export const OP_TEST_VAULT = "test-accounts";

/** Vault containing per-engineer API keys (1Password's built-in personal vault). */
export const OP_API_KEYS_VAULT = "Employee";

/** Item within OP_API_KEYS_VAULT holding the developer's API keys. */
export const OP_DEV_KEYS_ITEM = "Developer API Keys";

/**
 * Field within OP_DEV_KEYS_ITEM where the user's local admin (sudo) password
 * is optionally stored. Populated when the user checks "Save to 1Password" on
 * the den local-dev unlock banner; read on server startup so subsequent
 * sessions unlock without prompting.
 */
export const OP_DEN_SUDO_FIELD = `${envKey("LOCAL_ADMIN_PWD")}`;

// ── Timeouts ─────────────────────────────────────────────────────────────────

/** Health check HTTP/shell ping timeout. */
export const HEALTH_CHECK_TIMEOUT_MS = 3_000;
/** Hosted environments (beta, prod) may be scaled to zero; a cold start takes seconds. */
export const HOSTED_HEALTH_CHECK_TIMEOUT_MS = 10_000;

/** Timeout for spawning short-lived CLI subprocesses (open, sudo, git). */
export const CLI_SPAWN_TIMEOUT_MS = 5_000;

/**
 * Exit code of `<cli> stack health` when it could not tell (docker did not
 * answer, the stack config could not be read): the check is unknown, not
 * down. Any other non-zero exit means the containers are not healthy.
 */
export const STACK_HEALTH_UNKNOWN_EXIT = 3;

/** Timeout for `gh api` calls (branch listing, repo search). */
export const GH_API_TIMEOUT_MS = 15_000;

/** Timeout for 1Password `op` CLI commands.
 *  Generous so macOS Touch ID biometric prompts have time to land
 *  (≤10s killed the loadtest seed mid-mint when the prompt took >10s). */
export const OP_CLI_TIMEOUT_MS = 60_000;

/** Git remote HEAD check timeout (fast operation, low timeout). */
export const GIT_REMOTE_TIMEOUT_MS = 2_000;

/** Time to wait for a daemon to produce initial output before retrying. */
export const DAEMON_QUICK_EXIT_MS = 3_000;

/** Delay between daemon log stream retries. */
export const DAEMON_RETRY_DELAY_MS = 5_000;

/** Lines of immediate context a live log stream starts with (deeper history
 *  is paged on demand via /api/service/history). */
export const LIVE_TAIL_LINES = 500;

/** Window of time to show detached process output before closing the stream. */
export const DETACH_WINDOW_MS = 5_000;

/** Max time to wait for a `depends_on: { wait: true }` dependency to become healthy before starting the dependent. */
export const READINESS_TIMEOUT_MS = 60_000;

/** Poll interval while waiting for a `wait: true` dependency to become healthy. */
export const READINESS_INTERVAL_MS = 1_000;

/** Daemon graceful shutdown timeout. */
export const DAEMON_SHUTDOWN_GRACE_MS = 5_000;

// ── Cache TTLs ───────────────────────────────────────────────────────────────

/** TTL for cached GitHub branch listings. */
export const BRANCH_CACHE_TTL_MS = 60_000;

/** TTL for cached GitHub repo/org listings. */
export const REPO_CACHE_TTL_MS = 5 * 60_000;

// ── Log rotation ─────────────────────────────────────────────────────────────

/**
 * Size at which a service log is rotated. Service logs are written by DETACHED
 * children holding an inherited O_APPEND fd, so a chatty one grows without
 * bound — a localstack tail was measured at 8.6 GB.
 */
export const MAX_LOG_BYTES = 128 * 1024 * 1024;

/** How much of the tail is preserved into `<name>.log.1` when rotating. */
export const ROTATED_KEEP_BYTES = 32 * 1024 * 1024;

/** How often the server sweeps the log tree for oversized files. */
export const LOG_SWEEP_INTERVAL_MS = 15 * 60_000;

// ── Test file patterns ───────────────────────────────────────────────────────

/** File extension patterns per test pillar. */
export const TEST_FILE_EXTENSIONS: Record<string, string[]> = {
  smoke: [".smoke.ts"],
  synthetic: [".spec.ts", ".test.ts"],
  integration: [".spec.ts", ".test.ts"],
  performance: [".js"],
};

/** Directories to skip when scanning for test modules. */
export const SKIP_TEST_DIRS = [
  "user-flows",
  "helpers",
  "fixtures",
  "utils",
] as const;

// ── Server ───────────────────────────────────────────────────────────────────

/** Default den web server port. */
export const DEFAULT_PORT = 7777;
