/**
 * Journeys sandbox + credential isolation (plan: jrn-runner packet,
 * Approach §Credential isolation — four ordered layers).
 *
 * Layer 1 — captureSecrets(): CURSOR_API_KEY (env var when set — CI; else
 *   the secrets backend, at the `journeys_agent_key` named ref — see
 *   namedSecretRef: `secrets.refs.journeys_agent_key` in the org config,
 *   field label = env-var name). The Cursor key is held in memory only;
 *   nothing is written to disk and process.env is not mutated. The API
 *   assertion token is NOT minted here; it is derived from the real browser
 *   session (deriveApiTokenFromSession) after provisionBrowserSession,
 *   giving navigation and assertions the same real-user token.
 * Layer 2 — fail-closed shell denial: prepareSandbox() stages a cwd
 *   containing a generated .cursor/ tree — hooks.json (whose
 *   beforeShellExecution hook runs the checked-in deny script, copied
 *   into the staged dir so the path resolves from there, with
 *   `failClosed: true` — hooks are otherwise fail-open) plus
 *   permissions.json allowlisting only the custom-user-tools MCP server.
 *   This deny hook is the shell guard. The runner passes
 *   `settingSources: ["project"]` so this .cursor/ config is loaded;
 *   the OS sandbox (`sandboxOptions`) is DISABLED because it blocks the
 *   custom-tool MCP calls the journey depends on (and journeys need the
 *   network for browser navigation + API probes regardless).
 * Layer 4 — TranscriptScrubber/TranscriptWriter: the persist path holds
 *   the set of live secret values and fails the run loudly if any would
 *   be written (runner maps SecretLeakError to failure_kind=infra_error).
 *
 * ORDERING IS LOAD-BEARING: all secret-consuming provisioning
 * (captureSecrets, provisionBrowserSession) must complete BEFORE
 * sanitizeEnvironment() — which reduces the env to an explicit executor
 * ALLOWLIST (denylist kept as belt and braces) — which must complete
 * before Agent.create. The runner (runner.ts) owns that sequence and
 * snapshots the env BEFORE captureSecrets so restore() never
 * reintroduces secrets minted during capture; isolation tests pin it.
 */

import * as fs from "fs";
import * as path from "path";
import { OP_API_KEYS_VAULT, OP_DEV_KEYS_ITEM } from "../../shared/constants.js";
import {
  getSecretsProvider,
  namedSecretRef,
  type SecretRef,
} from "../../shared/secrets/index.js";
import type { Environment } from "../../shared/types/index.js";
import type { JourneyPersonaRole } from "./spec/schema.js";

import { product } from "../../shared/product.js";
import { enginePath } from "../../shared/engine.js";
import { getDistRoot } from "../../shared/paths.js";
import { containsValue } from "../../shared/redact.js";
// ── Layer 1: captureSecrets ──────────────────────────────────────────────────

/** 1Password field label holding the Cursor API key (= env var name). */
export const CURSOR_API_KEY_FIELD = "CURSOR_API_KEY";

/** Name of the agent-key ref under `secrets.refs` in the org config. */
export const JOURNEYS_AGENT_KEY_REF = "journeys_agent_key";

/**
 * Where the agent key lives when `secrets.refs.journeys_agent_key` is not
 * configured: the engineer's own developer-keys item (neutral default).
 */
export const JOURNEYS_AGENT_KEY_DEFAULT: SecretRef = {
  vault: OP_API_KEYS_VAULT,
  item: OP_DEV_KEYS_ITEM,
  field: CURSOR_API_KEY_FIELD,
};

/**
 * Secrets captured into memory before environment sanitization.
 *
 * This carries no API/persona JWT: the API assertion token is derived from
 * the real browser session (see deriveApiTokenFromSession) AFTER
 * provisioning, so the runner never mints a token via a password grant.
 * captureSecrets is solely responsible for the Cursor API key.
 */
export interface CapturedSecrets {
  /** Passed explicitly to Agent.create — never re-read from process.env. */
  cursorApiKey: string;
}

export interface OpFieldRequest {
  item: string;
  vault: string;
  field: string;
}

export interface CaptureSecretsDeps {
  /** Injectable `op` field reader (unit tests mock the CLI through this). */
  opReadField?: (request: OpFieldRequest) => Promise<string>;
  /** Env-var source; defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Where the key lives; defaults to the configured `journeys_agent_key` ref. */
  agentKeyRef?: SecretRef;
}

/** Default reader: the configured secrets strategy. */
async function defaultOpReadField(request: OpFieldRequest): Promise<string> {
  // Resolved through the configured secrets strategy (src/shared/secrets).
  return getSecretsProvider().get(request);
}

/**
 * Source CURSOR_API_KEY (env var first — CI; else the secrets backend),
 * holding it in memory only. Fails loudly, naming both sources, when no key
 * can be obtained. The API-assertion token is NOT minted here; it is
 * derived from the browser session after provisioning.
 */
export async function captureSecrets(
  _role: JourneyPersonaRole,
  _env: Environment,
  deps: CaptureSecretsDeps = {},
): Promise<CapturedSecrets> {
  const { opReadField = defaultOpReadField, env: envVars = process.env } = deps;

  let cursorApiKey = envVars[CURSOR_API_KEY_FIELD]?.trim() ?? "";
  if (cursorApiKey.length === 0) {
    let opError = "";
    const ref =
      deps.agentKeyRef ??
      namedSecretRef(JOURNEYS_AGENT_KEY_REF, JOURNEYS_AGENT_KEY_DEFAULT);
    try {
      cursorApiKey = (
        await opReadField({
          item: ref.item,
          vault: ref.vault,
          field: ref.field,
        })
      ).trim();
    } catch (error) {
      opError = error instanceof Error ? error.message : String(error);
    }
    if (cursorApiKey.length === 0) {
      throw new Error(
        `No Cursor API key available for journey agents.\n` +
          `  Options:\n` +
          `    • CI: set the ${CURSOR_API_KEY_FIELD} env var\n` +
          `    • Local: sign in to the secrets backend (make ${product().cli}-setup-secrets) and\n` +
          `      make sure the "${ref.item}" item in the "${ref.vault}" vault has a\n` +
          `      ${ref.field} field (move it with secrets.refs.${JOURNEYS_AGENT_KEY_REF})\n` +
          (opError ? `  Secrets backend error: ${opError}\n` : ""),
      );
    }
  }

  return { cursorApiKey };
}

// ── Sanitize environment ─────────────────────────────────────────────────────

/**
 * Secret-bearing vars that must NEVER survive into the executor env, even
 * if a future allowlist entry would otherwise admit them (belt and
 * braces over the allowlist below). Exact names plus prefix/pattern
 * classes.
 */
const SANITIZED_EXACT: readonly string[] = [CURSOR_API_KEY_FIELD];
const SANITIZED_PATTERNS: readonly RegExp[] = [
  /^E2E_/,
  /^SMOKE_.*_TOKEN$/,
  /^AUTH0_/,
];

/**
 * Executor env ALLOWLIST: everything NOT matching is removed before
 * Agent.create (the local executor and tool processes inherit den's
 * process env at spawn). Denylist wins over allowlist. Documented
 * classes:
 * - process/OS basics: PATH, HOME, TMPDIR/TMP/TEMP, SHELL, USER,
 *   LOGNAME, LANG, LC_*, TZ, TERM, COLORTERM;
 * - Node/npm toolchain: NODE_*, NVM_*, npm_* (tsx/node subprocesses);
 * - journeys operator config: JOURNEYS_* (non-secret by contract —
 *   e.g. JOURNEYS_MODEL).
 * Ambient credentials (AWS_*, SENTRY_*, GH_* / GITHUB_*, OP_SESSION_*,
 * …) are excluded by construction rather than enumerated.
 */
export const EXECUTOR_ENV_ALLOWLIST_EXACT: readonly string[] = [
  "PATH",
  "HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "SHELL",
  "USER",
  "LOGNAME",
  "LANG",
  "TZ",
  "TERM",
  "COLORTERM",
];
export const EXECUTOR_ENV_ALLOWLIST_PATTERNS: readonly RegExp[] = [
  /^NODE_/,
  /^NVM_/,
  /^npm_/,
  /^LC_/,
  /^JOURNEYS_/,
];

function isDenylisted(key: string): boolean {
  return (
    SANITIZED_EXACT.includes(key) ||
    SANITIZED_PATTERNS.some((pattern) => pattern.test(key))
  );
}

function isAllowlisted(key: string): boolean {
  return (
    EXECUTOR_ENV_ALLOWLIST_EXACT.includes(key) ||
    EXECUTOR_ENV_ALLOWLIST_PATTERNS.some((pattern) => pattern.test(key))
  );
}

export interface SanitizeResult {
  /** Names of the vars that were removed. */
  removed: readonly string[];
  /** Restore every removed var (call in finally). */
  restore(): void;
}

/**
 * Reduce `env` (default process.env) to the executor allowlist, returning
 * a restore handle. A key is removed when it is denylisted OR not
 * allowlisted. The caller owns invoking restore() in a finally block.
 *
 * When `baseline` (a snapshot of the env taken BEFORE captureSecrets) is
 * provided, restore() reinstates removed keys from the baseline instead
 * of their pre-sanitize values — so a secret INTRODUCED during secret
 * capture (e.g. getApiToken exporting E2E_AUTH0_CLIENT_SECRET) is never
 * restored into the process env after the run.
 */
export function sanitizeEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  baseline?: Readonly<Record<string, string | undefined>>,
): SanitizeResult {
  const saved = new Map<string, string>();
  for (const key of Object.keys(env)) {
    const remove = isDenylisted(key) || !isAllowlisted(key);
    if (remove && env[key] !== undefined) {
      saved.set(key, env[key] as string);
      delete env[key];
    }
  }
  return {
    removed: [...saved.keys()],
    restore(): void {
      for (const [key, savedValue] of saved) {
        const value = baseline ? baseline[key] : savedValue;
        if (value !== undefined) {
          env[key] = value;
        } else {
          delete env[key];
        }
      }
    },
  };
}

// ── Layer 2: staged sandbox cwd + fail-closed deny hook ─────────────────────

/** Checked-in deny-hook script (copied into every staged sandbox). */
const DENY_SCRIPT_SOURCE = enginePath(
  "src/pillars/journeys/hooks/deny-shell.cjs",
);

/** Relative (from the staged dir — project hooks run from the project root). */
const DENY_SCRIPT_RELATIVE = ".cursor/hooks/deny-shell.cjs";

/**
 * The SDK exposes `customTools` to the agent as an MCP server named
 * `custom-user-tools` (see @cursor/sdk options.d.ts). We allowlist the
 * whole server in permissions.json because our own harness tools
 * (browser_* / http_request) are trusted by construction. With the OS
 * sandbox disabled (see runner.ts) headless custom tools already run
 * without approval, so this allowlist is belt-and-suspenders — it keeps
 * the tools auto-approved if the sandbox / a Run Mode is ever re-enabled.
 * Shell is deliberately NOT allowlisted (no `terminalAllowlist`) and
 * stays denied by the beforeShellExecution hook below.
 */
const CUSTOM_TOOLS_MCP_ALLOWLIST = ["custom-user-tools:*"] as const;

export interface StagedSandbox {
  /** Staged cwd passed to Agent.create({local: {cwd}}). */
  dir: string;
  hooksJsonPath: string;
  /** Path of the generated `.cursor/permissions.json`. */
  permissionsJsonPath: string;
  /** Absolute path of the deny script copy inside the staged dir. */
  denyScriptPath: string;
}

export interface PrepareSandboxOptions {
  /** Parent directory for staged cwds; defaults to .journeys-run/. */
  baseDir?: string;
}

/**
 * Stage `<baseDir>/<journey>-<ts>/` containing the generated `.cursor/`
 * config the SDK loads via `settingSources: ["project"]`:
 *   - `hooks.json` + the deny-script copy it references (shell denied,
 *     `failClosed: true` so shell is denied even if the script errors —
 *     hooks are fail-open by default, verified against
 *     cursor.com/docs/agent/hooks);
 *   - `permissions.json` allowlisting the harness's own `custom-user-tools`
 *     MCP server so the agent can call browser_* / http_request without an
 *     (impossible, headless) approval prompt while the sandbox Run Mode is
 *     active. Shell is deliberately absent from any allowlist.
 */
export function prepareSandbox(
  journeyName: string,
  options: PrepareSandboxOptions = {},
): StagedSandbox {
  const baseDir =
    options.baseDir ?? path.resolve(getDistRoot(), ".journeys-run");
  const slug = journeyName.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = path.join(baseDir, `${slug}-${timestamp}`);

  const hooksDir = path.join(dir, ".cursor", "hooks");
  fs.mkdirSync(hooksDir, { recursive: true });

  const denyScriptPath = path.join(hooksDir, "deny-shell.cjs");
  fs.copyFileSync(DENY_SCRIPT_SOURCE, denyScriptPath);

  const hooksJsonPath = path.join(dir, ".cursor", "hooks.json");
  const hooksConfig = {
    version: 1,
    hooks: {
      beforeShellExecution: [
        {
          command: `node ${DENY_SCRIPT_RELATIVE}`,
          failClosed: true,
        },
      ],
    },
  };
  fs.writeFileSync(hooksJsonPath, `${JSON.stringify(hooksConfig, null, 2)}\n`);

  const permissionsJsonPath = path.join(dir, ".cursor", "permissions.json");
  const permissionsConfig = {
    mcpAllowlist: [...CUSTOM_TOOLS_MCP_ALLOWLIST],
  };
  fs.writeFileSync(
    permissionsJsonPath,
    `${JSON.stringify(permissionsConfig, null, 2)}\n`,
  );

  return { dir, hooksJsonPath, permissionsJsonPath, denyScriptPath };
}

// ── Layer 4: transcript scrubber ─────────────────────────────────────────────

/** A live secret value was about to be persisted — the run must fail. */
export class SecretLeakError extends Error {
  constructor() {
    // Deliberately value-free: the error itself must not carry the secret.
    super(
      "Transcript persist blocked: content matched a live secret value. " +
        "The journey fails closed (failure_kind=infra_error).",
    );
    this.name = "SecretLeakError";
  }
}

/**
 * Holds the set of live secret values for the run and refuses to let any
 * of them be persisted. Empty values are ignored (they would match
 * everything).
 */
export class TranscriptScrubber {
  private readonly secrets: string[];

  constructor(secrets: readonly string[]) {
    this.secrets = secrets.filter((value) => value.length > 0);
  }

  /** Throws SecretLeakError when `text` contains any live secret value. */
  assertClean(text: string): void {
    if (containsValue(text, this.secrets)) throw new SecretLeakError();
  }
}

/**
 * JSONL transcript writer whose persist path runs through the scrubber:
 * every serialized message is checked BEFORE it reaches disk, so a leak
 * aborts the append rather than redacting after the fact.
 */
export class TranscriptWriter {
  private readonly filePath: string;
  private readonly scrubber: TranscriptScrubber;

  constructor(filePath: string, scrubber: TranscriptScrubber) {
    this.filePath = filePath;
    this.scrubber = scrubber;
  }

  async append(message: unknown): Promise<void> {
    const line = JSON.stringify(message);
    this.scrubber.assertClean(line);
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.appendFileSync(this.filePath, `${line}\n`);
  }
}
