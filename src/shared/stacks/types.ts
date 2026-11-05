/**
 * A stack = one repo's Docker Compose project, run behind the edge.
 *
 *   stacks:
 *     webapp:
 *       repo: sample-webapp
 *       files: [docker-compose.yml]          # relative to repo/dir
 *       routes: { app: frontend:80 }         # https://app.webapp.<domain>
 *       generate: [SECRET_KEY]               # random once, kept in local state
 *       uses: [ragstack]                    # start first + private link network
 *       env:                                 # compose ${VAR} substitution
 *         RAG_PROXY_TARGET: "http://{ragstack.ragstack-server}:80"
 *       secret_env:                          # from the secrets provider, at up/restart
 *         OPENAI_API_KEY: proj/dev/OPENAI_API_KEY
 *
 * `{stack.service}` expands to that service's container name.
 */
export interface StackConfig {
  name: string;
  repo: string;
  /** Absolute checkout path; when unset, `<repos_root>/<repo>`. */
  repoPath?: string;
  /** Subdirectory of the repo holding the compose files. */
  dir?: string;
  files: string[];
  /** `<route>` → `<service>:<container port>`. */
  routes: Record<string, string>;
  generate: string[];
  uses: string[];
  env: Record<string, string>;
  /** Compose profiles to enable. */
  profiles: string[];
  /** service → replacement healthcheck `test`, for a repo's broken check. */
  healthchecks?: Record<string, string[]>;
  /**
   * service → environment variables set on that service (override wins by
   * key). For values a repo's compose file hard-codes, which `env` (compose
   * `${VAR}` substitution) cannot change.
   */
  serviceEnv?: Record<string, Record<string, string>>;
  /**
   * `secret_env` (R16): env var → `<vault>/<item>/<field>` ref. Resolved
   * through the secrets provider by `stack up` / `stack restart` and passed
   * only in the docker compose process's env, never in the override file.
   */
  secretEnv?: Record<string, string>;
}

/** What `docker compose config --format json` tells us about a service. */
export interface ResolvedService {
  container_name?: string;
  ports?: unknown[];
  networks?: Record<string, unknown> | null;
  environment?: Record<string, string | null> | null;
}

export interface ResolvedProject {
  name: string;
  services: Record<string, ResolvedService>;
  networks?: Record<string, { name?: string }>;
}
