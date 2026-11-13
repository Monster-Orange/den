/**
 * Shared TypeScript types for Den
 */

export interface EnvironmentConfig {
  name: string;
  baseUrls: {
    web: string;
    api: string;
    services: Record<string, string>;
  };
  /**
   * Which identity provider mints test tokens for this environment.
   * Strategy, not code: see src/shared/auth/token-providers.
   * Defaults to "auth0" when an `auth0` block is present, else "none".
   */
  auth?: AuthConfig;
  /** Auth0 settings — required only when auth.provider is "auth0". */
  auth0?: {
    domain: string;
    clientId: string;
    audience: string;
    /**
     * Optional dotenv file (relative to the den root, e.g. an app
     * checkout's `.env.local`) whose AUTH0_CLIENT_SECRET is the local-dev
     * fallback for the client secret.
     */
    clientSecretEnvFile?: string;
  };
  timeouts: {
    api: number;
    pageLoad: number;
  };
}

export type AuthProviderName = "auth0" | "cognito" | "local-jwt" | "none";

export interface AuthConfig {
  provider: AuthProviderName;
  /**
   * How the headless browser login reaches the IdP and recognises success.
   * Defaults: start at "/" (the app redirects to its IdP) and treat any
   * page back on the app origin as signed in.
   */
  browser?: BrowserLoginConfig;
  /** AWS Cognito user pool app client (USER_PASSWORD_AUTH flow). */
  cognito?: {
    region: string;
    clientId: string;
    /** Use the ID token instead of the access token as the bearer. */
    useIdToken?: boolean;
  };
  /** Self-signed HS256 JWT for local stacks that verify a shared secret. */
  localJwt?: {
    /** Env var / secrets flat key holding the signing secret. */
    secretKey: string;
    issuer?: string;
    audience?: string;
    ttlSeconds?: number;
    /** Extra claims merged into every token. */
    claims?: Record<string, unknown>;
  };
}

export interface BrowserLoginConfig {
  /** App path that starts the login redirect (e.g. "/auth/login"). Default "/". */
  loginPath?: string;
  /**
   * App path a signed-in session can open (session checks navigate here and
   * expect to stay on it). Default "/".
   */
  signedInPath?: string;
}

export interface Credentials {
  regular: {
    username: string;
    password: string;
    auth0ClientId?: string;
  };
  elevated?: {
    username: string;
    password: string;
  };
  lastUpdated: string;
}

export interface TestResult {
  timestamp: string;
  pillar: Pillar;
  environment: string;
  test: string;
  status: "passed" | "failed" | "skipped";
  duration: number;
  user: string;
  error?: string;
  screenshot?: string;
  trace?: string;
  metadata?: Record<string, unknown>;
}

export interface SlackConfig {
  webhookUrl: string;
  enabled: boolean;
  notifyOn: {
    testComplete: boolean;
    testFailure: boolean;
    thresholdExceeded: boolean;
  };
  thresholds: {
    failurePercentage: number;
  };
  channel: string;
}

export interface TestSummary {
  pillar: string;
  environment: string;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  duration: number;
  passRate: number;
}

export interface FlakyTest {
  test: string;
  runs: number;
  failures: number;
  flakyRate: number;
}

export interface TrendData {
  date: string;
  passRate: number;
  avgDuration: number;
  totalTests: number;
}

export type Environment =
  | "local"
  | "dev"
  | "sandbox"
  | "staging"
  | "beta"
  | "prod"
  | "production";
export type Pillar =
  | "synthetic"
  | "integration"
  | "performance"
  | "smoke"
  | "journeys"
  | "security"
  | "suites";

// ── Schema validation types ───────────────────────────────────────────────────

export interface ValidationError {
  /** Dot-separated path to the offending field, e.g. "services.api.health.local". Empty string for top-level parse errors. */
  path: string;
  /** Human-readable description of the problem. */
  message: string;
  /** Optional remediation hint, e.g. "Did you mean X?" */
  suggestion?: string;
  /** The manifest layer file the error is in, when validating by layer. */
  file?: string;
}

export interface ValidationResult {
  /** True when the manifest passes all checks with no errors. Warnings do not affect validity. */
  valid: boolean;
  /** Detected schema version (defaults to 1 when no version field is present). */
  version: number;
  /** Fatal validation errors — must be fixed before the manifest can be used. */
  errors: ValidationError[];
  /** Non-fatal warnings — e.g. unknown future version, deprecated patterns. */
  warnings: ValidationError[];
}

// ── .den.json manifest types ─────────────────────────────────────────────

export type LogSource =
  | { type: "process"; distinct?: boolean }
  | { type: "shell"; cmd: string; distinct?: boolean }
  | {
      type: "cloudwatch";
      logGroup: string;
      logStream?: string;
      region?: string;
      /**
       * Marks a SUBSYSTEM's log as its own listed source in the /logs view
       * (e.g. shop/db runs shop's own postgres, not infra-stack's shared
       * one). Without it, only a system's primary service log is listed.
       */
      distinct?: boolean;
    };

/**
 * Health check config for a service in a given environment.
 *
 * HTTP (default):
 *   url: "https://api.example.com/healthz"
 *   -- or explicitly --
 *   type: http
 *   url: "https://api.example.com/healthz"
 *
 * Shell command (for services without an HTTP endpoint, e.g. Postgres):
 *   type: shell
 *   cmd: "docker exec $(docker ps --filter ancestor=postgres:16 --format '{{.ID}}' | head -1) pg_isready -U postgres"
 *   label: "postgres"   # optional — shown in UI instead of cmd
 *
 * Container (answered from the one `docker ps` a health cycle shares):
 *   type: container
 *   project: shop-main     # com.docker.compose.project label
 *   service: db            # com.docker.compose.service label
 *   -- or, for a container not run by compose --
 *   type: container
 *   container_name: shop-db
 */
export type ServiceHealthConfig =
  | { type?: "http"; url: string; label?: string }
  | { type: "shell"; cmd: string; label?: string }
  | ({ type: "container"; label?: string } & (
      | { project: string; service: string; container_name?: undefined }
      | { container_name: string; project?: undefined; service?: undefined }
    ));

/**
 * A command can be a plain shell string or an object that explicitly
 * controls behaviour. up and restart detach by default; every other command
 * runs to completion unless it says `detachable: true` (0.3.0-dev.40):
 *
 *   up: make up               # string — detached (up and restart)
 *   preflight: make check     # string — runs to completion
 *   seed:
 *     cmd: make db-seed
 *     detachable: false       # wait for exit, stream output until done
 *   setup:
 *     cmd: make auth-login
 *     detachable: false
 *     interactive: true       # hand full stdin/stdout/stderr to the user's TTY
 *                             # required when the command prompts for input (HITL)
 */
export type CommandDef =
  | string
  | { cmd: string; detachable?: boolean; interactive?: boolean };

/**
 * A `depends_on` entry. String form for the common case; object form to opt
 * into blocking startup on the dep's health check (`wait: true`).
 *
 *   depends_on:
 *     - tasks-runner                         # string — fire-and-forget (default)
 *     - { service: shop/db, wait: true }            # block this service's start until shop/db is healthy
 */
export type DependsOnEntry = string | { service: string; wait?: boolean };

export interface ServiceManagementConfig {
  /** env → command-name → command definition. Omit env key if not supported. */
  commands?: Partial<Record<Environment, Record<string, CommandDef>>>;
  /** env → log source. Omit env key if not supported. */
  logs?: Partial<Record<Environment, LogSource>>;
  /** env → health check URL. Omit env key if not supported. */
  health?: Partial<Record<Environment, ServiceHealthConfig>>;
  /**
   * env → where the app opens in a browser (the UI's open-in-new-tab link).
   * Unset: the local edge route, else the origin of the env's HTTP health URL.
   */
  urls?: Partial<Record<Environment, string>>;
  /** Extra named links per env (docs, admin, API explorer…). */
  links?: ServiceLink[];
  /**
   * Other managed services this service depends on.
   * Use service addresses: "tasks-runner", "shop/api", etc.
   * Den will start dependencies before this service.
   *
   * Default is fire-and-forget (5-second detach). To block on a dep's health
   * check before starting this service, use the object form: { service, wait: true }.
   */
  depends_on?: DependsOnEntry[];
  /** OWASP ZAP options: `openapi` per env turns on the API scan; `skip` leaves it out. */
  security?: { openapi?: Partial<Record<Environment, string>>; skip?: boolean };
  /**
   * Where the service runs, per env (R13): `local` (on this machine) or
   * `remote` (deployed elsewhere; Den never starts, stops, scans or execs
   * it). Unset envs fall back to the defaults in manifest/placement.ts.
   */
  runs?: Partial<Record<Environment, ServiceRunsValue>>;
  /** Where a remote service runs: the env, an account label, a URL to probe. */
  target?: ServiceTargetConfig;
  /**
   * R16: env var → `<vault>/<item>/<field>` ref, resolved through the
   * secrets provider when this service's up/restart command runs, and set
   * only in that process's env (see src/shared/secrets/secret-env.ts).
   */
  secret_env?: Record<string, string>;
}

export type ServiceRunsValue = "local" | "remote";

export interface ServiceTargetConfig {
  /** One of the org's environments. */
  env: string;
  /** A label for where it is deployed (e.g. a cloud account). */
  account?: string;
  /** Probed for health when target.env declares no health check. */
  url?: string;
  /** Status codes that count as up when probing `url` (default any 2xx). */
  expect?: number | number[];
}

export interface ServiceLink {
  label: string;
  urls: Partial<Record<Environment, string>>;
}

/**
 * Where the deployed commit for one environment is read from. The first that
 * answers wins: `version` (JSON endpoint; `field` holds the SHA, default
 * "build"), then `deployment` (a GitHub environment), then the newest
 * successful run of the repo's release `workflow` on main.
 */
export interface ReleaseSourceConfig {
  version?: string;
  field?: string;
  deployment?: string;
}

export interface ReleaseManifestConfig {
  workflow?: string;
  environments?: Partial<Record<Environment, ReleaseSourceConfig>>;
}

/** A repo-owned test suite Den can run from the checkout. */
export interface TestSuiteConfig {
  cmd: string;
  cwd?: string;
  label?: string;
  /** Den environments it may run against (default: local only). */
  environments?: Environment[];
}

export interface SmokeStorageFixtureConfig {
  endpoint?: string;
  endpointFromEnv?: string;
  apiEndpoint?: string;
  apiEndpointFromEnv?: string;
  bucket?: string;
  bucketFromEnv?: string;
  accessKey?: string;
  accessKeyFromEnv?: string;
  secretKey?: string;
  secretKeyFromEnv?: string;
  cleanupContext?: SmokeCleanupContextConfig;
  setup?: CommandDef;
  teardown?: CommandDef;
  /**
   * If set, Den GETs `{baseUrl}{adminProbePath}` before tests when this storage fixture is active.
   * Use a lightweight admin route that shares the same guard as teardown (e.g. files-api
   * `GET /api/v1/admin/ingest-queue/status`). Omit when teardown does not call admin HTTP APIs.
   */
  adminProbePath?: string;
  /**
   * Service-authored remediation text appended to the error when `adminProbePath` returns 403.
   * Den does not interpret this string — it is passed verbatim to the operator. Example:
   *   "Set ENABLE_ADMIN_ENDPOINTS in stack.yml for this env, run make infra-sync, and redeploy."
   * Omit to fall back to the raw 403 response body in the error message.
   */
  adminProbe403Hint?: string;
  /**
   * Extra env vars merged into the fixture process env for `setup` / `teardown`
   * (e.g. `PG_*` for repo-owned cleanup scripts). Values should be strings in
   * `.den.yml`; YAML numbers are coerced to strings.
   */
  teardownEnv?: Record<string, string | number | boolean>;
}

export interface SmokeObjectStoreCleanupTargetConfig {
  endpoint?: string;
  endpointFromEnv?: string;
  bucket?: string;
  bucketFromEnv?: string;
  accessKey?: string;
  accessKeyFromEnv?: string;
  secretKey?: string;
  secretKeyFromEnv?: string;
}

export interface SmokeCleanupContextConfig {
  objectStores?: Record<string, SmokeObjectStoreCleanupTargetConfig>;
}

/**
 * Teardown-only smoke fixture: runs a repo-owned sweep command after the
 * suite, with no object-storage payload. Unlike the storage fixture, it is
 * acquired AFTER JWT warming, so the teardown env includes SMOKE_*_TOKEN —
 * required by repos (e.g. shop) whose sweep goes through JWT-authed APIs.
 */
export interface SmokeCleanupFixtureConfig {
  setup?: CommandDef;
  teardown: CommandDef;
  /** Same semantics as the storage fixture's adminProbePath. */
  adminProbePath?: string;
  /** Same semantics as the storage fixture's adminProbe403Hint. */
  adminProbe403Hint?: string;
  /**
   * Extra env vars merged into the fixture process env for `setup` /
   * `teardown` (e.g. `ENVIRONMENT` so the script can refuse production).
   */
  teardownEnv?: Record<string, string | number | boolean>;
}

export interface SmokeFixturesConfig {
  storage?: Partial<Record<Environment, SmokeStorageFixtureConfig>>;
  cleanup?: Partial<Record<Environment, SmokeCleanupFixtureConfig>>;
}

/** Smoke test config for a single service (lives under `smoke.<name>` in the manifest). */
export interface SmokeServiceConfig {
  testDir: string;
  testMatch: string;
  baseUrlKey: "api" | "web";
  auth: ("admin" | "user" | "beta")[];
  fixtures?: SmokeFixturesConfig;
}

/**
 * Declarative launch-time option for a perf test, surfaced as a form control in
 * the web UI and resolved into an env var on THIS test's k6 process. Tests
 * declare these in their co-located `manifest.yml` (Den-local) or under
 * `performance.<name>.optionalFields` in `.den.yml` (repo-owned).
 */
export type PerfOptionalFieldType = "boolean" | "select" | "string" | "number";

export interface PerfOptionalField {
  /** Field id, unique within a test. Used as the values map key + localStorage key. */
  name: string;
  /** Form label shown in the UI. */
  label: string;
  /** Control type → which form widget renders + how the value is resolved. */
  type: PerfOptionalFieldType;
  /** Env var set on THIS test's k6 process when the field resolves to a value. */
  env: string;
  /** Seed value when the user has not chosen one. */
  default?: string | number | boolean;
  /** Tooltip / help text. */
  description?: string;
  /** Allowed values for `type: select`. */
  options?: Array<{ value: string; label: string }>;
  /** For `type: boolean`: env value emitted when true (default "1"); env omitted when false. */
  emit?: string;
  /** Greys out the control (and skips the env at runtime) when the referenced field equals the given value. */
  disabledWhen?: { field: string; equals: string | number | boolean };
}

/** Performance test config for a single module (lives under `performance.<name>` in the manifest). */
export interface PerformanceServiceConfig {
  /** When false, Den skips this module (no k6 run, no storage fixture acquire). Default: enabled. */
  enabled?: boolean;
  testDir: string;
  testMatch: string;
  baseUrlKey: "api" | "web";
  service: string;
  tags?: string[];
  fixtures?: SmokeFixturesConfig;
  /** Declarative launch-time options for repo-owned perf tests (via .den.yml). */
  optionalFields?: PerfOptionalField[];
}

/**
 * Alias for {@link PerformanceServiceConfig}. The module scanner historically
 * imports this name; kept as an alias so both spellings resolve to one shape.
 */
export type PerformanceModuleConfig = PerformanceServiceConfig;

/** Synthetics config (lives under `synthetics` in the manifest). */
export interface SyntheticsConfig {
  testDir: string;
  testMatch: string;
  baseUrlKey: "api" | "web";
  auth: ("admin" | "user" | "beta")[];
}

/**
 * Journeys config (lives under top-level `journeys` in the manifest).
 * Deliberately thinner than SyntheticsConfig: no baseUrlKey (the journeys
 * runner resolves both web and api base URLs from env config) and no auth
 * array (each journey spec's persona.role declares its own role).
 */
export interface JourneysConfig {
  testDir: string;
  testMatch: string;
  /**
   * The app under test (resources, session token, web-origin API feed).
   * Raw here; parsed and validated by the journeys pillar
   * (src/pillars/journeys/app-config.ts).
   */
  app?: unknown;
}

/**
 * Optional GitHub metadata in .den.yml.
 * Owner/repo are auto-derived from git remote, so this section is only
 * needed when the den environment name differs from the GitHub environment
 * name (rare — by convention they match).
 */
export interface GitHubManifestConfig {
  /**
   * Map den environment names → GitHub environment names.
   * Only needed for overrides; unspecified envs default to the den name.
   * e.g.  production: prod
   */
  environments?: Partial<Record<Environment, string>>;
}

/** ZAP scan modes, least to most intrusive: passive-only, API active, full active. */
export type SecurityMode = "baseline" | "api" | "full";

/**
 * Security (ZAP) scan target for a single service (lives under
 * `security.<name>` in the manifest). Either `baseUrlKey` or `hosts` must be
 * present; explicit `hosts` win when both are given for an environment.
 */
export interface SecurityServiceConfig {
  /** Resolve the target from the den environment config (baseUrls.api / baseUrls.web). */
  baseUrlKey?: "api" | "web";
  /** Explicit env → target base URLs; wins over baseUrlKey for that env. */
  hosts?: Partial<Record<Environment, string[]>>;
  /** Repo-relative OpenAPI spec path, or a URL template (`{baseUrl}` expands). */
  openapi?: string;
  /** Roles to authenticate as; empty/omitted = unauthenticated scan. */
  auth?: ("admin" | "user" | "beta")[];
  /** Regexes (no whitespace) over URLs ZAP must not touch. */
  exclude?: string[];
  /** Allowed modes per env; capped by the pillar's per-env ceiling regardless. */
  modes?: Partial<Record<Environment, SecurityMode[]>>;
}

/** Parsed .den.yml/.den.json manifest — top-level shape. */
export interface RawManifest {
  name: string;
  /**
   * Front-door service for cross-repo depends_on.
   * When another repo lists this multi-service repo by bare name in its
   * depends_on, den resolves it to "repoName/entrypoint".
   * Single-service repos need no declaration — bare name is always correct.
   */
  entrypoint?: string;
  smoke?: Record<string, SmokeServiceConfig>;
  performance?: Record<string, PerformanceServiceConfig>;
  synthetics?: SyntheticsConfig;
  journeys?: JourneysConfig;
  security?: Record<string, SecurityServiceConfig>;
  services?: Record<string, ServiceManagementConfig>;
  github?: GitHubManifestConfig;
  release?: ReleaseManifestConfig;
  tests?: Record<string, TestSuiteConfig>;
  /** The application (config/den.yml `applications:`) this repo belongs to. */
  application?: string;
  /**
   * What the repo is. `service` (the default) runs on its own and has a
   * status. `module` is code a host service loads or invokes (a bolt-on);
   * `library` is code other repos import. Neither has a runtime of its own:
   * den never starts or health-checks them and shows what they
   * contribute to instead.
   */
  kind?: RepoKind;
  /** For a module or library: the repos it contributes to. */
  contributes_to?: string[];
  /**
   * D47: agents reach this service only through its API, never its
   * containers, volumes, `data_paths` or OrbStack `machine`.
   */
  agents?: "api_only";
  /** D47: the service's data, relative to the repo or absolute (~ is home). */
  data_paths?: string[];
  /** D47: the OrbStack machine the service runs in. */
  machine?: string;
  /**
   * The repo is a Docker Compose project: den runs it with no host ports
   * behind the edge, and supplies up/down/restart/logs/health unless the
   * entrypoint service declares its own.
   */
  compose?: ManifestComposeConfig;
}

export type RepoKind = "service" | "module" | "library";

export interface ManifestComposeConfig {
  /** Stack name, used in hostnames; defaults to the manifest name. */
  name?: string;
  dir?: string;
  files?: string[];
  routes?: Record<string, string>;
  generate?: string[];
  /** Other stacks (by stack or repo name) this one calls. */
  uses?: string[];
  env?: Record<string, string | number | boolean>;
  profiles?: string[];
  /** service → replacement healthcheck `test` (written to den's override, not the repo). */
  healthchecks?: Record<string, string[]>;
  /** service → env vars set on that service in the override (wins by key). */
  service_env?: Record<string, Record<string, string | number | boolean>>;
  /**
   * R16: env var → `<vault>/<item>/<field>` ref, resolved through the
   * secrets provider at stack up/restart and set only in the docker compose
   * process's env (for the compose file's `${VAR}` / pass-through
   * `environment:` entries). Never written to the override.
   */
  secret_env?: Record<string, string>;
}

export interface MigrationResult {
  /** The migrated manifest, ready to write back to disk. */
  manifest: RawManifest;
  /** Schema version of the input manifest (1 when no version field was present). */
  fromVersion: number;
  /** Schema version of the output manifest. */
  toVersion: number;
  /** Human-readable descriptions of each transformation applied. Empty when nothing changed. */
  changes: string[];
}

/** A repo discovered under .den/<name>/ with its parsed manifest. */
export interface DiscoveredRepo {
  repoName: string;
  repoPath: string;
  manifest: RawManifest;
}

// ── Service catalog & workspace types ────────────────────────────────────────

export interface ServiceCatalogEntry {
  /**
   * Full GitHub slug: "Globex-Corp/repo-name" — used when cloning managed
   * repos. GitHub shorthand: a repo on another host (or none) sets `remote`.
   */
  gh?: string;
  /**
   * The repo's git URL, for any host (ORG-1d): `https://…`, `ssh://…`,
   * `git@host:owner/repo.git`, `file://…` or an absolute path. A repo whose
   * org has no source that claims it clones and pulls from here through
   * plain git and the user's own credential helper.
   */
  remote?: string;
}

/** Keyed by GH repo name (e.g. "shop", "tasks-runner") */
export type ServiceCatalog = Record<string, ServiceCatalogEntry>;

export interface WorkspaceServiceEntry {
  /**
   * Auto-start toggle: absent (or true) = the system starts with workspace-wide
   * ups (web master ▶ Up, `den up` closure walks). false = skipped by the
   * STARTING half of workspace-wide ops (up/restart) — but workspace down still
   * stops it, and explicit targeting (card ⋮ up, `den up <repo>`) always
   * wins. Toggled per system from the web ⋮ menu.
   */
  autostart?: boolean;
  /**
   * How this service is managed in this workspace.
   *   dev-managed     — developer's own checkout; den never modifies it
   *   managed  — den clones and tracks a branch in .den-services/<repo>/
   */
  mode: "dev-managed" | "managed";
  /**
   * For linked repos: absolute path to the local checkout in this workspace.
   */
  path?: string;
  /**
   * For managed repos: branch to track. Defaults to "main".
   */
  branch?: string;
}

export interface WorkspaceConfig {
  /**
   * D70: the name the person typed ("back office"), when it isn't the key.
   * The key is its slug ("back-office"): paths, URLs and the CLI use it.
   */
  name?: string;
  /**
   * Agents in this workspace, on this machine (AG-0.5):
   * `agents.runtimes.<id>.bin`, a runtime's CLI for this workspace's
   * agents, which wins over user.yml's and the search. den#48:
   * `agents.permission`, the permission mode (ask, edits, auto, all) its
   * agents start with when the start names none, over their persona's.
   */
  agents?: {
    runtimes?: Record<string, { bin?: unknown } | null>;
    permission?: unknown;
  };
  /**
   * Service entries keyed by service address.
   * Single-service repos: "tasks-runner"
   * Mono-repo subsystems: "shop/api", "shop/web"
   */
  services: Record<string, WorkspaceServiceEntry>;
  /**
   * Feature workspace: path to the directory containing managed clones.
   * Relative to den root. Only managed repos are cloned here —
   * linked repos always stay in their own location on disk.
   */
  directory?: string;
  /**
   * Managed repos to clone into the workspace directory, keyed by
   * GH repo name. Only valid when directory is set.
   */
  repos?: Record<string, string>; // repoName → branch
  /**
   * Optional editor override for this workspace. When set, opening the workspace
   * directory uses this editor instead of the user's global default.
   * Per-language overrides (from stack.yml) still take precedence at repo level.
   */
  editor?: string;
  /**
   * Blueprint repo list (`defaults.workspace.repos`) as last applied to this
   * workspace — `default` workspace only. Top-up converges on blueprint
   * DELTAS against this list, so a standard repo the user removed stays
   * removed instead of resurrecting on the next command; only repos that
   * newly JOIN the blueprint are added.
   */
  seeded_repos?: string[];
  /**
   * The org this workspace belongs to (ORG-1a), set per machine. Wins over
   * the blueprint's `org:`; when neither is set the org is inferred from the
   * repos' catalog owners, then `github_org`. Never written by Den: the
   * resolved org is computed on read (see workspace-org.ts).
   */
  org?: string;
  /**
   * The Compose project suffix this workspace's stacks run under, in place of
   * its own name (`default`: `main`). Workspaces that set the same value
   * share their stacks' projects, and so their volumes and data. Wins over
   * the blueprint's `stack_namespace`. See stacks/namespace.ts.
   */
  stack_namespace?: string;
  /**
   * H5: the Hub project this project works on, as the person linked it
   * (`hub link`, Settings › Project setup): {id, slug, name}. Den sends the
   * id on every Hub call (X-Den-Project). See shared/hub-project-link.ts.
   */
  hub_project?: unknown;
}

export interface WorkspacesFile {
  /**
   * Workspaces currently active (may be more than one). Services may run
   * under any active workspace; see daemon ownership / conflict rules.
   */
  active: string[];
  /**
   * UI/CLI default target workspace. Must be a member of `active` when set.
   * Resolved via DEN_WORKSPACE_OVERRIDE → focus → active[0].
   */
  focus?: string;
  workspaces: Record<string, WorkspaceConfig>;
}

/** Runtime-resolved service info — not persisted */
export interface ResolvedService {
  /** Service address as used in workspace config: "shop/api" or "tasks-runner" */
  address: string;
  /** GH repo name (catalog key): "shop" or "tasks-runner" */
  repoName: string;
  /** Subsystem key from .den.yml services block: "api", "web", or same as repoName */
  subsystem: string;
  /** Absolute path to the repo root for this workspace context */
  repoPath: string;
  /** Branch currently targeted (null for linked repos — den doesn't control their branch) */
  branch: string | null;
  mode: "dev-managed" | "managed";
}

export interface TokenSet {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
  token_type?: string;
  scope?: string;
  [key: string]: unknown;
}
