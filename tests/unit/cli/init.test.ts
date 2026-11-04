import { describe, expect, it, jest, afterEach } from "@jest/globals";
import * as fs from "fs";
import * as yaml from "yaml";
import { validateManifest } from "../../../src/shared/manifest/validate-manifest.js";

jest.mock("fs");

import {
  buildInitManifest,
  buildEnvHealthUrls,
  detectCloudwatchLogGroups,
  defaultLocalHealthUrl,
  detectStackConfig,
  detectLiveHealthPath,
  detectPulumiDeployment,
  formatManifestYaml,
  mergeManifestPreserving,
} from "../../../src/ui/cli/init.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

const mockReadFileSync = fs.readFileSync as jest.MockedFunction<
  typeof fs.readFileSync
>;
const mockExistsSync = fs.existsSync as jest.MockedFunction<
  typeof fs.existsSync
>;

afterEach(() => jest.resetAllMocks());

// ── detectStackConfig ─────────────────────────────────────────────────────────

describe("detectStackConfig", () => {
  it("returns null when .stack.yml does not exist", () => {
    mockExistsSync.mockReturnValue(false);
    expect(detectStackConfig("/repos/my-service")).toBeNull();
  });

  it("returns parsed service names when .stack.yml has services block", () => {
    mockExistsSync.mockImplementation(
      (p: unknown) =>
        String(p).endsWith(".stack.yml") || String(p).endsWith(".stack.yaml"),
    );
    mockReadFileSync.mockReturnValue(
      "services:\n  api:\n    port: 8000\n  worker:\n    port: 8001\n",
    );
    const result = detectStackConfig("/repos/my-service");
    expect(result).not.toBeNull();
    expect(result?.services).toEqual(expect.arrayContaining(["api", "worker"]));
  });

  it("returns service port hints when available", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue("services:\n  api:\n    port: 9000\n");
    const result = detectStackConfig("/repos/my-service");
    expect(result?.ports?.api).toBe(9000);
  });

  it("returns null when .stack.yml exists but has no services block", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue("name: my-service\n");
    expect(detectStackConfig("/repos/my-service")).toBeNull();
  });

  it("returns null when .stack.yml is invalid YAML", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue("{{bad: [yaml");
    expect(detectStackConfig("/repos/my-service")).toBeNull();
  });

  it("extracts language field when present as a string", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      "name: my-svc\nlanguage: go\nservices:\n  api:\n    port: 8080\n",
    );
    const result = detectStackConfig("/repos/my-service");
    expect(result?.language).toBe("go");
  });

  it("returns undefined language when field is not present", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      "name: my-svc\nservices:\n  api:\n    port: 8080\n",
    );
    const result = detectStackConfig("/repos/my-service");
    expect(result?.language).toBeUndefined();
  });

  it("ignores non-string language values", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      "name: my-svc\nlanguage: 42\nservices:\n  api: {}\n",
    );
    const result = detectStackConfig("/repos/my-service");
    expect(result?.language).toBeUndefined();
  });

  it("prefers stack.yml (no dot) over .stack.yml when both exist", () => {
    // Both files exist — should read stack.yml (first candidate)
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockImplementation((p) =>
      String(p).endsWith("/stack.yml") && !String(p).endsWith("/.stack.yml")
        ? "name: my-svc\nlanguage: python\nservices:\n  api: {}\n"
        : "name: my-svc\nlanguage: ruby\nservices:\n  api: {}\n",
    );
    const result = detectStackConfig("/repos/my-service");
    expect(result?.language).toBe("python");
    expect(mockReadFileSync).toHaveBeenCalledWith(
      "/repos/my-service/stack.yml",
      "utf-8",
    );
  });
});

// ── detectStackConfig: stack v2 local port discovery ──────────────────────────

describe("detectStackConfig — stack v2 config.local.PORT", () => {
  it("discovers the local port from config.local.PORT when there is no services block", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      "name: control-plane\nconfig:\n  defaults:\n    LOG_LEVEL: info\n  local:\n    LOG_LEVEL: debug\n    PORT: 80\n",
    );
    const result = detectStackConfig("/repos/control-plane");
    expect(result).not.toBeNull();
    expect(result?.localPort).toBe(80);
    // stack v2 has no top-level services: block
    expect(result?.services).toEqual([]);
  });

  it("falls back to config.defaults.PORT when config.local has no PORT (unresolved <<: *defaults)", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      'name: links-api\nconfig:\n  defaults:\n    PORT: "8000"\n  local:\n    LOG_LEVEL: debug\n',
    );
    const result = detectStackConfig("/repos/links-api");
    expect(result?.localPort).toBe(8000);
  });

  it("prefers config.local.PORT over config.defaults.PORT and coerces string ports", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      'name: files-api\nconfig:\n  defaults:\n    PORT: "8000"\n  local:\n    PORT: "80"\n',
    );
    const result = detectStackConfig("/repos/files-api");
    expect(result?.localPort).toBe(80);
  });

  it("returns null when there is no services block AND no config port AND no language", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      "name: bare\nconfig:\n  local:\n    LOG_LEVEL: debug\n",
    );
    expect(detectStackConfig("/repos/bare")).toBeNull();
  });

  it("leaves localPort undefined for an stack v1 services-only file", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue("services:\n  api:\n    port: 9000\n");
    const result = detectStackConfig("/repos/v1");
    expect(result?.ports?.api).toBe(9000);
    expect(result?.localPort).toBeUndefined();
  });
});

// ── defaultLocalHealthUrl ─────────────────────────────────────────────────────

describe("defaultLocalHealthUrl", () => {
  it("uses the bare-name form (opctl DNS, port 80) when the local port is 80", () => {
    expect(defaultLocalHealthUrl("control-plane", 80)).toBe(
      "http://control-plane/healthz",
    );
  });

  it("appends a non-80 local port explicitly", () => {
    expect(defaultLocalHealthUrl("links-api", 8000)).toBe(
      "http://links-api:8000/healthz",
    );
  });

  it("defaults to the bare-name (port 80) form when the port is unknown", () => {
    expect(defaultLocalHealthUrl("svc")).toBe("http://svc/healthz");
    expect(defaultLocalHealthUrl("svc", undefined)).toBe("http://svc/healthz");
  });

  it("never emits a localhost URL", () => {
    expect(defaultLocalHealthUrl("svc", 8080)).not.toMatch(/localhost/);
  });
});

// ── buildInitManifest ─────────────────────────────────────────────────────────

describe("buildInitManifest", () => {
  it("builds a minimal manifest with just a name", () => {
    const manifest = buildInitManifest({ name: "my-service", services: [] });
    expect(manifest.name).toBe("my-service");
    expect(manifest.version).toBe(1);
  });

  it("sets version to 1", () => {
    const manifest = buildInitManifest({ name: "svc", services: [] });
    expect(manifest.version).toBe(1);
  });

  it("adds a single service entry when one service provided", () => {
    const manifest = buildInitManifest({
      name: "svc",
      services: [{ name: "api", healthUrl: "http://svc:8080/healthz" }],
    });
    expect(manifest.services?.api).toBeDefined();
    expect(manifest.services?.api?.health?.local).toEqual({
      url: "http://svc:8080/healthz",
    });
  });

  it("does not set entrypoint for a single-service manifest", () => {
    const manifest = buildInitManifest({
      name: "svc",
      services: [{ name: "api" }],
    });
    expect(manifest.entrypoint).toBeUndefined();
  });

  it("sets entrypoint when multiple services and entrypoint specified", () => {
    const manifest = buildInitManifest({
      name: "shop",
      services: [{ name: "api" }, { name: "web" }],
      entrypoint: "api",
    });
    expect(manifest.entrypoint).toBe("api");
  });

  it("includes default local commands (up/down/restart) for each service", () => {
    const manifest = buildInitManifest({
      name: "svc",
      services: [{ name: "api" }],
    });
    const cmds = manifest.services?.api?.commands?.local;
    expect(cmds?.up).toBeDefined();
    expect(cmds?.down).toBeDefined();
  });

  it("reflects detected make targets — adds setup, drops absent restart", () => {
    const manifest = buildInitManifest({
      name: "svc",
      services: [{ name: "api" }],
      makeTargets: ["up", "down", "setup", "build", "lint"],
    });
    const cmds = manifest.services?.api?.commands?.local as Record<
      string,
      string
    >;
    expect(cmds).toEqual({
      up: "make up",
      down: "make down",
      setup: "make setup",
    });
    expect(cmds.restart).toBeUndefined(); // not a target → not emitted
  });

  it("falls back to the up/down/restart scaffold when no standard targets detected", () => {
    const manifest = buildInitManifest({
      name: "svc",
      services: [{ name: "api" }],
      makeTargets: ["build", "lint"], // no standard lifecycle targets
    });
    const cmds = manifest.services?.api?.commands?.local as Record<
      string,
      string
    >;
    expect(Object.keys(cmds).sort()).toEqual(["down", "restart", "up"]);
  });

  it("adds shell health check when healthCmd provided instead of URL", () => {
    const manifest = buildInitManifest({
      name: "svc",
      services: [{ name: "db", healthCmd: "pg_isready -h localhost" }],
    });
    const health = manifest.services?.db?.health?.local as Record<
      string,
      unknown
    >;
    expect(health?.type).toBe("shell");
    expect(health?.cmd).toBe("pg_isready -h localhost");
  });

  it("produces a manifest that passes schema validation", () => {
    const manifest = buildInitManifest({
      name: "complex-svc",
      services: [
        { name: "api", healthUrl: "http://svc:8080/healthz" },
        { name: "worker" },
      ],
      entrypoint: "api",
    });
    const result = validateManifest(manifest);
    expect(result.valid).toBe(true);
  });

  it("scaffolds deployed-env health URLs from templates on the single service", () => {
    const manifest = buildInitManifest({
      name: "jobs-runtime",
      services: [{ name: "worker", healthUrl: "http://jobs-runtime/health" }],
      envHealthUrls: {
        dev: "https://{repo}.internal.dev.example.dev/healthz",
        production: "https://{repo}.internal.example.dev/healthz",
      },
    });
    const health = manifest.services?.worker?.health;
    expect(health?.local).toEqual({ url: "http://jobs-runtime/health" });
    expect(health?.dev).toEqual({
      url: "https://jobs-runtime.internal.dev.example.dev/healthz",
    });
    expect(health?.production).toEqual({
      url: "https://jobs-runtime.internal.example.dev/healthz",
    });
  });

  it("scaffolds env health only on the entrypoint of a multi-service repo", () => {
    const manifest = buildInitManifest({
      name: "shop",
      services: [{ name: "db" }, { name: "api" }],
      entrypoint: "api",
      envHealthUrls: { dev: "https://{repo}.internal.dev.example.dev/healthz" },
    });
    expect(manifest.services?.api?.health?.dev).toEqual({
      url: "https://shop.internal.dev.example.dev/healthz",
    });
    expect(manifest.services?.db?.health?.dev).toBeUndefined();
  });

  it("never lets an env template override the user's local answer", () => {
    const manifest = buildInitManifest({
      name: "svc",
      services: [{ name: "svc", healthUrl: "http://svc/healthz" }],
      envHealthUrls: { local: "https://WRONG/healthz", dev: "https://d/h" },
    });
    expect(manifest.services?.svc?.health?.local).toEqual({
      url: "http://svc/healthz",
    });
  });
});

// ── mergeManifestPreserving ───────────────────────────────────────────────────

describe("mergeManifestPreserving", () => {
  const generated = () =>
    buildInitManifest({
      name: "jobs-runtime",
      services: [{ name: "worker", healthUrl: "http://jobs-runtime/health" }],
      envHealthUrls: {
        dev: "https://{repo}.internal.dev.example.dev/healthz",
        sandbox: "https://{repo}.internal.sandbox.example.dev/healthz",
      },
    });

  it("keeps hand-authored non-local health URLs over generated templates", () => {
    const existing = {
      version: 1,
      name: "jobs-runtime",
      services: {
        worker: {
          health: {
            local: { url: "http://OLD-LOCAL/healthz" },
            dev: { url: "https://custom.dev.example.com/healthz" },
          },
        },
      },
    } as never;
    const out = mergeManifestPreserving(existing, generated());
    const health = out.services?.worker?.health;
    // freshly answered local wins; hand-authored dev wins; template sandbox stays
    expect(health?.local).toEqual({ url: "http://jobs-runtime/health" });
    expect(health?.dev).toEqual({
      url: "https://custom.dev.example.com/healthz",
    });
    expect(health?.sandbox).toEqual({
      url: "https://jobs-runtime.internal.sandbox.example.dev/healthz",
    });
  });

  it("preserves hand-authored logs blocks", () => {
    const existing = {
      version: 1,
      name: "jobs-runtime",
      services: {
        worker: {
          logs: { dev: { type: "cloudwatch", logGroup: "/aws/x" } },
        },
      },
    } as never;
    const out = mergeManifestPreserving(existing, generated());
    expect(out.services?.worker?.logs).toEqual({
      dev: { type: "cloudwatch", logGroup: "/aws/x" },
    });
  });

  it("does not resurrect services removed from the new manifest, and no-ops on null", () => {
    const existing = {
      version: 1,
      name: "jobs-runtime",
      services: { ghost: { health: { dev: { url: "https://g/h" } } } },
    } as never;
    const out = mergeManifestPreserving(existing, generated());
    expect(out.services?.ghost).toBeUndefined();
    expect(mergeManifestPreserving(null, generated())).toEqual(generated());
  });

  // Regression: regenerating shop-web's manifest once dropped smoke,
  // synthetics, preflight, depends_on, and every logs block because the
  // service key was renamed (shop-web → app) and top-level sections were
  // never carried over.
  it("survives full regeneration of a hand-authored manifest (shop-web shape)", () => {
    const existing = {
      name: "shop-web",
      smoke: {
        web: {
          testDir: "tests/smoke",
          testMatch: "**/*.smoke.ts",
          baseUrlKey: "web",
          auth: ["user"],
        },
      },
      synthetics: {
        testDir: "tests/synthetic",
        testMatch: "**/*.spec.ts",
        baseUrlKey: "web",
        auth: ["admin", "user"],
      },
      services: {
        "shop-web": {
          depends_on: ["shop"],
          commands: {
            local: {
              up: "make up",
              down: "make down",
              preflight: "make preflight",
              setup: "make setup",
            },
          },
          logs: {
            local: { type: "shell", cmd: "docker logs -f x" },
            dev: {
              type: "cloudwatch",
              logGroup: "/aws/ecs/shop__app_instance__dev",
            },
            sandbox: {
              type: "cloudwatch",
              logGroup: "/aws/ecs/shop__app_instance__sandbox",
            },
            staging: {
              type: "cloudwatch",
              logGroup: "/aws/ecs/shop__app_instance__staging",
            },
          },
          health: {
            local: { url: "http://localhost:3000" },
            dev: { url: "https://app.dev.example.dev" },
          },
        },
      },
    } as never;
    const regenerated = buildInitManifest({
      name: "shop-web",
      services: [{ name: "app", healthUrl: "http://shop-web/api/health" }],
      makeTargets: ["up", "down", "setup", "restart"],
      envHealthUrls: {
        dev: "https://app.dev.example.dev/api/health",
        production: "https://app.example.dev/api/health",
      },
    });
    const out = mergeManifestPreserving(existing, regenerated);

    // top-level hand-authored sections survive
    expect(out.smoke).toEqual((existing as RawManifest).smoke);
    expect(out.synthetics).toEqual((existing as RawManifest).synthetics);
    // single-service key rename still matches the old service
    const app = out.services?.app;
    expect(out.services?.["shop-web"]).toBeUndefined();
    // commands: scaffold + hand-authored extras merge, existing wins
    expect(app?.commands?.local).toMatchObject({
      up: "make up",
      preflight: "make preflight",
      restart: "make restart",
    });
    // logs: all envs preserved
    expect(Object.keys(app?.logs ?? {}).sort()).toEqual([
      "dev",
      "local",
      "sandbox",
      "staging",
    ]);
    // health: fresh local wins, hand-authored dev wins, new production stays
    expect(app?.health?.local).toEqual({
      url: "http://shop-web/api/health",
    });
    expect(app?.health?.dev).toEqual({ url: "https://app.dev.example.dev" });
    expect(app?.health?.production).toEqual({
      url: "https://app.example.dev/api/health",
    });
    // depends_on preserved
    expect(app?.depends_on).toEqual(["shop"]);
  });
});

// ── formatManifestYaml ────────────────────────────────────────────────────────

describe("formatManifestYaml", () => {
  it("returns a YAML string", () => {
    const manifest = { version: 1, name: "svc" };
    const output = formatManifestYaml(manifest);
    expect(typeof output).toBe("string");
  });

  it("output is valid YAML that round-trips", () => {
    const manifest = {
      version: 1,
      name: "svc",
      services: {
        api: {
          commands: { local: { up: "make up" } },
        },
      },
    };
    const output = formatManifestYaml(manifest);
    const parsed = yaml.parse(output);
    expect(parsed.name).toBe("svc");
    expect(parsed.version).toBe(1);
  });

  it("includes a header comment mentioning den", () => {
    const output = formatManifestYaml({ version: 1, name: "svc" });
    expect(output).toMatch(/den/i);
  });

  it("notes that dependency order is derived (depends_on optional)", () => {
    const output = formatManifestYaml({ version: 1, name: "svc" });
    expect(output).toMatch(/derived/i);
    expect(output).toMatch(/depends_on/);
  });

  it("places version at the top of the file", () => {
    const output = formatManifestYaml({ version: 1, name: "svc" });
    const lines = output
      .split("\n")
      .filter((l) => l.trim() && !l.startsWith("#"));
    expect(lines[0]).toMatch(/^version:/);
  });
});

// ── detectPulumiDeployment / buildEnvHealthUrls / detectLiveHealthPath ────────

describe("detectPulumiDeployment", () => {
  it("reads app_subdomain + alb_health_check_path per env (public app)", () => {
    mockExistsSync.mockImplementation((p: unknown) =>
      String(p).endsWith("Pulumi.dev.yaml"),
    );
    mockReadFileSync.mockReturnValue(
      "config:\n  PlatformApp:app_subdomain: app\n  PlatformApp:alb_health_check_path: /api/health\n",
    );
    const envs = detectPulumiDeployment("/repos/shop-web");
    expect(envs.dev).toEqual({
      appSubdomain: "app",
      albSubdomain: undefined,
      healthPath: "/api/health",
    });
    expect(envs.production).toBeUndefined(); // no Pulumi.prod.yaml
  });

  it("reads alb_subdomain (internal ALB) and tolerates missing pulumi dir", () => {
    mockExistsSync.mockImplementation((p: unknown) =>
      String(p).endsWith("Pulumi.prod.yaml"),
    );
    mockReadFileSync.mockReturnValue(
      "config:\n  x_stack:alb_subdomain: control-plane-prod\n  x_stack:alb_health_check_path: /healthz\n",
    );
    const envs = detectPulumiDeployment("/repos/control-plane");
    expect(envs.production?.albSubdomain).toBe("control-plane-prod");
    mockExistsSync.mockReturnValue(false);
    expect(detectPulumiDeployment("/repos/none")).toEqual({});
  });
});

describe("buildEnvHealthUrls", () => {
  const templates = {
    dev: "https://{repo}.internal.dev.example.dev/healthz",
    production: "https://{repo}.internal.example.dev/healthz",
  };

  it("public app: <sub>.<env-domain> + declared path; prod drops the env segment", () => {
    const urls = buildEnvHealthUrls(
      "shop-web",
      {
        dev: { appSubdomain: "app", healthPath: "/api/health" },
        production: { appSubdomain: "app", healthPath: "/api/health" },
      },
      templates,
    );
    expect(urls.dev).toBe("https://app.dev.example.dev/api/health");
    expect(urls.production).toBe("https://app.example.dev/api/health");
  });

  it("internal ALB: config template host with the declared path", () => {
    const urls = buildEnvHealthUrls(
      "control-plane",
      { dev: { albSubdomain: "control-plane-dev", healthPath: "/healthz" } },
      templates,
    );
    expect(urls.dev).toBe(
      "https://control-plane.internal.dev.example.dev/healthz",
    );
  });

  it("no evidence → no URLs (nothing fabricated)", () => {
    expect(buildEnvHealthUrls("mystery", {}, templates)).toEqual({});
  });
});

describe("detectLiveHealthPath", () => {
  const fetchSeq = (handler: (url: string) => number | Error) =>
    (async (url: unknown) => {
      const r = handler(String(url));
      if (r instanceof Error) throw r;
      return { status: r } as Response;
    }) as typeof fetch;

  it("probes candidates in order and returns the first 2xx (declared path first)", async () => {
    const calls: string[] = [];
    const hit = await detectLiveHealthPath("shop-web", {
      declaredPath: "/api/health",
      fetchImpl: fetchSeq((u) => {
        calls.push(u);
        return u.endsWith("/api/health") ? 200 : 404;
      }),
    });
    expect(hit).toEqual({ path: "/api/health", status: 200 });
    expect(calls[0]).toBe("http://shop-web/api/health");
  });

  it("skips 404s and finds a later convention path", async () => {
    const hit = await detectLiveHealthPath("svc", {
      fetchImpl: fetchSeq((u) => (u.endsWith("/api/health") ? 200 : 404)),
    });
    expect(hit).toEqual({ path: "/api/health", status: 200 });
  });

  it("bails immediately when the host is unreachable", async () => {
    const calls: string[] = [];
    const hit = await detectLiveHealthPath("down-svc", {
      fetchImpl: fetchSeq((u) => {
        calls.push(u);
        return new Error("ENOTFOUND");
      }),
    });
    expect(hit).toBeNull();
    expect(calls).toHaveLength(1); // no pointless retries against a dead host
  });

  it("uses repo:port host for non-80 ports", async () => {
    const calls: string[] = [];
    await detectLiveHealthPath("svc", {
      port: 8000,
      fetchImpl: fetchSeq((u) => {
        calls.push(u);
        return 200;
      }),
    });
    expect(calls[0]).toBe("http://svc:8000/healthz");
  });
});

// ── detectCloudwatchLogGroups ─────────────────────────────────────────────────

describe("detectCloudwatchLogGroups", () => {
  it("finds exact <candidate>/<envToken> matches and excludes prefix-cousins", () => {
    const calls: string[] = [];
    const groups = detectCloudwatchLogGroups(
      "jobs-runtime",
      { dev: "dev", production: "prod" },
      {
        execImpl: (cmd) => {
          calls.push(cmd);
          if (
            cmd.includes('"/jobs_runtime"') &&
            cmd.includes('--profile "dev"')
          )
            return JSON.stringify([
              "/jobs_runtime/dev",
              "/jobs_runtime_coldstart_test/dev", // must NOT be picked
            ]);
          if (
            cmd.includes('"/jobs_runtime"') &&
            cmd.includes('--profile "prod"')
          )
            return JSON.stringify(["/jobs_runtime/prod"]);
          return JSON.stringify([]);
        },
      },
    );
    expect(groups).toEqual({
      dev: "/jobs_runtime/dev",
      production: "/jobs_runtime/prod", // env token prod, den env key production
    });
  });

  it("skips envs whose aws session fails, keeps working ones", () => {
    const groups = detectCloudwatchLogGroups(
      "search-api",
      { dev: "dev", staging: "staging" },
      {
        execImpl: (cmd) => {
          if (cmd.includes('--profile "staging"'))
            throw new Error("ExpiredToken");
          if (cmd.includes('"/aws/ecs/search-api"'))
            return JSON.stringify(["/aws/ecs/search-api/dev"]);
          return JSON.stringify([]);
        },
      },
    );
    expect(groups).toEqual({ dev: "/aws/ecs/search-api/dev" });
  });

  it("returns empty when nothing matches exactly", () => {
    const groups = detectCloudwatchLogGroups(
      "svc",
      { dev: "dev" },
      { execImpl: () => JSON.stringify(["/svc_other/dev"]) },
    );
    expect(groups).toEqual({});
  });
});

describe("buildInitManifest — envLogGroups", () => {
  it("adds cloudwatch logs blocks on the primary service only", () => {
    const m = buildInitManifest({
      name: "jobs-runtime",
      services: [{ name: "worker" }],
      envLogGroups: {
        dev: "/jobs_runtime/dev",
        production: "/jobs_runtime/prod",
      },
    });
    expect(m.services?.worker?.logs?.dev).toEqual({
      type: "cloudwatch",
      logGroup: "/jobs_runtime/dev",
    });
    expect(m.services?.worker?.logs?.production).toEqual({
      type: "cloudwatch",
      logGroup: "/jobs_runtime/prod",
    });
  });
});

describe("mergeManifestPreserving — per-env logs merge", () => {
  it("keeps hand-authored log envs over detected ones, fills gaps from detection", () => {
    const existing = {
      version: 1,
      name: "jobs-runtime",
      services: {
        worker: {
          logs: {
            local: { type: "shell", cmd: "docker logs -f x" },
            dev: { type: "cloudwatch", logGroup: "/custom/dev" },
          },
        },
      },
    } as never;
    const generated = buildInitManifest({
      name: "jobs-runtime",
      services: [{ name: "worker" }],
      envLogGroups: {
        dev: "/jobs_runtime/dev",
        staging: "/jobs_runtime/staging",
      },
    });
    const out = mergeManifestPreserving(existing, generated);
    const logs = out.services?.worker?.logs;
    expect(logs?.local).toEqual({ type: "shell", cmd: "docker logs -f x" }); // preserved
    expect(logs?.dev).toEqual({ type: "cloudwatch", logGroup: "/custom/dev" }); // hand-authored wins
    expect(logs?.staging).toEqual({
      type: "cloudwatch",
      logGroup: "/jobs_runtime/staging",
    }); // detected fills gap
  });
});
