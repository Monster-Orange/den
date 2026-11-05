import { describe, expect, it } from "@jest/globals";
import { validateManifest } from "../../../src/shared/manifest/validate-manifest.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

const VALID_MINIMAL = { name: "my-service" };

const VALID_FULL = {
  version: 1,
  name: "files-api",
  entrypoint: "api",
  services: {
    api: {
      depends_on: ["shop/api"],
      commands: {
        local: {
          up: "make up",
          down: "make down",
        },
      },
      health: {
        local: { url: "http://files-api:8080/healthz" },
      },
      logs: {
        local: { type: "shell", cmd: "docker logs -f files-api" },
      },
    },
    db: {
      health: {
        local: { type: "shell", cmd: "pg_isready -h localhost" },
      },
    },
  },
  smoke: {
    api: {
      testDir: "tests/smoke",
      testMatch: "**/*.spec.ts",
      baseUrlKey: "api",
      auth: ["admin", "user"],
    },
  },
};

const VALID_MINIMAL_YAML = "name: my-service";

// ── Valid manifests ───────────────────────────────────────────────────────────

describe("validateManifest — valid inputs", () => {
  it("accepts a minimal manifest with only name", () => {
    const result = validateManifest(VALID_MINIMAL);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("accepts a full well-formed manifest object", () => {
    const result = validateManifest(VALID_FULL);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("accepts a raw YAML string", () => {
    const result = validateManifest(VALID_MINIMAL_YAML);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("reports version 1 for manifests with no version field", () => {
    const result = validateManifest(VALID_MINIMAL);
    expect(result.version).toBe(1);
  });

  it("reports version 1 for manifests with explicit version: 1", () => {
    const result = validateManifest({ name: "svc", version: 1 });
    expect(result.version).toBe(1);
  });

  it("accepts entrypoint on a multi-service manifest", () => {
    const result = validateManifest({
      name: "shop",
      entrypoint: "api",
      services: { api: {}, web: {} },
    });
    expect(result.valid).toBe(true);
  });

  it("accepts depends_on as array of strings", () => {
    const result = validateManifest({
      name: "svc",
      services: { api: { depends_on: ["files-api", "shop/api"] } },
    });
    expect(result.valid).toBe(true);
  });

  it("accepts depends_on with the object form (service + wait)", () => {
    const result = validateManifest({
      name: "svc",
      services: {
        api: {
          depends_on: [
            "tasks-runner",
            { service: "shop/db", wait: true },
            { service: "files-api" },
          ],
        },
      },
    });
    expect(result.valid).toBe(true);
  });

  it("accepts http health check with only url", () => {
    const result = validateManifest({
      name: "svc",
      services: {
        api: { health: { local: { url: "http://svc:8080/healthz" } } },
      },
    });
    expect(result.valid).toBe(true);
  });

  it("accepts shell health check with type and cmd", () => {
    const result = validateManifest({
      name: "svc",
      services: {
        db: { health: { local: { type: "shell", cmd: "pg_isready" } } },
      },
    });
    expect(result.valid).toBe(true);
  });

  it("accepts commands as plain strings", () => {
    const result = validateManifest({
      name: "svc",
      services: {
        api: {
          commands: { local: { up: "make up", down: "make down" } },
        },
      },
    });
    expect(result.valid).toBe(true);
  });

  it("accepts commands as objects with cmd and options", () => {
    const result = validateManifest({
      name: "svc",
      services: {
        api: {
          commands: {
            local: {
              setup: { cmd: "make setup", interactive: true },
              migrate: { cmd: "make db-migrate", detachable: false },
            },
          },
        },
      },
    });
    expect(result.valid).toBe(true);
  });
});

// ── journeys block ────────────────────────────────────────────────────────────

describe("validateManifest — journeys block", () => {
  it("accepts a top-level journeys block with testDir and testMatch", () => {
    const result = validateManifest({
      name: "shop-web",
      journeys: { testDir: "tests/journeys", testMatch: "**/*.journey.yml" },
    });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("accepts journeys alongside a synthetics block (siblings)", () => {
    const result = validateManifest({
      name: "shop-web",
      synthetics: {
        testDir: "tests/synthetic",
        testMatch: "**/*.spec.ts",
        baseUrlKey: "web",
        auth: ["admin", "user"],
      },
      journeys: { testDir: "tests/journeys", testMatch: "**/*.journey.yml" },
    });
    expect(result.valid).toBe(true);
  });

  it("manifests without a journeys block stay valid", () => {
    const result = validateManifest(VALID_FULL);
    expect(result.valid).toBe(true);
  });

  it("returns invalid when journeys is missing testDir", () => {
    const result = validateManifest({
      name: "shop-web",
      journeys: { testMatch: "**/*.journey.yml" },
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.path.includes("testDir"))).toBe(true);
  });

  it("returns invalid when journeys is missing testMatch", () => {
    const result = validateManifest({
      name: "shop-web",
      journeys: { testDir: "tests/journeys" },
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.path.includes("testMatch"))).toBe(true);
  });

  it("returns invalid when journeys testDir is not a string", () => {
    const result = validateManifest({
      name: "shop-web",
      journeys: { testDir: 42, testMatch: "**/*.journey.yml" },
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.path.includes("testDir"))).toBe(true);
  });
});

// ── Errors ────────────────────────────────────────────────────────────────────

describe("validateManifest — errors", () => {
  it("returns invalid when name is missing", () => {
    const result = validateManifest({});
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("error for missing name has path 'name'", () => {
    const result = validateManifest({});
    const nameError = result.errors.find((e) => e.path === "name");
    expect(nameError).toBeDefined();
  });

  it("returns invalid when name is not a string", () => {
    const result = validateManifest({ name: 42 });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.path === "name")).toBe(true);
  });

  it("returns invalid when depends_on contains a non-string, non-object", () => {
    const result = validateManifest({
      name: "svc",
      services: { api: { depends_on: [123, "valid-dep"] } },
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.path.includes("depends_on"))).toBe(true);
  });

  it("returns invalid when depends_on object form omits service", () => {
    const result = validateManifest({
      name: "svc",
      services: { api: { depends_on: [{ wait: true }] } },
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.path.includes("depends_on"))).toBe(true);
  });

  it("returns invalid when depends_on wait is not a boolean", () => {
    const result = validateManifest({
      name: "svc",
      services: {
        api: { depends_on: [{ service: "shop/db", wait: "yes" }] },
      },
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.path.includes("depends_on"))).toBe(true);
  });

  it("returns invalid when smoke.auth contains an unrecognised role", () => {
    const result = validateManifest({
      name: "svc",
      smoke: {
        api: {
          testDir: "tests/smoke",
          testMatch: "**/*.spec.ts",
          baseUrlKey: "api",
          auth: ["superuser"],
        },
      },
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.path.includes("auth"))).toBe(true);
  });

  it("error for invalid auth includes a suggestion mentioning valid roles", () => {
    const result = validateManifest({
      name: "svc",
      smoke: {
        api: {
          testDir: "tests",
          testMatch: "**/*.spec.ts",
          baseUrlKey: "api",
          auth: ["superuser"],
        },
      },
    });
    const authErr = result.errors.find((e) => e.path.includes("auth"));
    expect(authErr?.suggestion).toMatch(/admin|user|beta/i);
  });

  it("returns invalid when smoke entry is missing required testDir", () => {
    const result = validateManifest({
      name: "svc",
      smoke: {
        api: { testMatch: "**/*.spec.ts", baseUrlKey: "api", auth: ["user"] },
      },
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.path.includes("testDir"))).toBe(true);
  });

  it("returns invalid when health.local has type http but no url", () => {
    const result = validateManifest({
      name: "svc",
      services: {
        api: { health: { local: { type: "http" } } },
      },
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.path.includes("health"))).toBe(true);
  });

  it("returns invalid when health.local has type shell but no cmd", () => {
    const result = validateManifest({
      name: "svc",
      services: {
        api: { health: { local: { type: "shell" } } },
      },
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.path.includes("health"))).toBe(true);
  });
});

// ── Warnings ─────────────────────────────────────────────────────────────────

describe("validateManifest — warnings", () => {
  it("returns valid but warns on unknown future version number", () => {
    const result = validateManifest({ name: "svc", version: 99 });
    expect(result.valid).toBe(true);
    expect(result.warnings.some((w) => w.path === "version")).toBe(true);
  });

  it("no warnings for a well-formed v1 manifest", () => {
    const result = validateManifest(VALID_FULL);
    expect(result.warnings).toHaveLength(0);
  });
});

// ── YAML string input ─────────────────────────────────────────────────────────

describe("validateManifest — YAML string input", () => {
  it("returns invalid with a parse error when YAML is malformed", () => {
    const result = validateManifest("name: [\nbad yaml{{}");
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.path === "")).toBe(true);
  });

  it("error message for bad YAML mentions 'parse' or 'yaml'", () => {
    const result = validateManifest("name: [\nbad yaml{{}");
    const parseErr = result.errors.find((e) => e.path === "");
    expect(parseErr?.message).toMatch(/parse|yaml/i);
  });

  it("validates a correct multi-line YAML string", () => {
    const yaml = [
      "name: shop",
      "entrypoint: api",
      "services:",
      "  api:",
      "    depends_on:",
      "      - files-api",
    ].join("\n");
    const result = validateManifest(yaml);
    expect(result.valid).toBe(true);
  });
});

// ── security block ────────────────────────────────────────────────────────────

describe("validateManifest — security block", () => {
  const withSecurity = (svc: Record<string, unknown>) => ({
    name: "sample-webapp",
    security: { api: svc },
  });

  it("accepts a minimal baseUrlKey entry", () => {
    expect(validateManifest(withSecurity({ baseUrlKey: "api" })).valid).toBe(
      true,
    );
  });

  it("accepts web and the full option set", () => {
    expect(validateManifest(withSecurity({ baseUrlKey: "web" })).valid).toBe(
      true,
    );
    const full = validateManifest(
      withSecurity({
        baseUrlKey: "api",
        hosts: { local: ["https://api.webapp.globex.localhost"] },
        openapi: "docs/openapi.yaml",
        auth: ["admin", "user"],
        exclude: ["^/auth/logout", "/admin/.*/delete"],
        modes: { local: ["baseline", "api", "full"], production: ["baseline"] },
      }),
    );
    expect(full.errors).toEqual([]);
    expect(full.valid).toBe(true);
  });

  it("accepts hosts alone (no baseUrlKey)", () => {
    expect(
      validateManifest(
        withSecurity({
          hosts: { local: ["https://app.webapp.globex.localhost"] },
        }),
      ).valid,
    ).toBe(true);
  });

  it("manifests without a security block stay valid", () => {
    expect(validateManifest({ name: "sample-webapp" }).valid).toBe(true);
  });

  it("rejects an entry with neither baseUrlKey nor hosts", () => {
    const result = validateManifest(withSecurity({ openapi: "o.yaml" }));
    expect(result.valid).toBe(false);
    expect(result.errors.map((e) => e.message).join()).toMatch(
      /baseUrlKey.*hosts/,
    );
  });

  it("rejects an unknown baseUrlKey, auth role, mode, or env key", () => {
    for (const key of ["db", "labs"]) {
      expect(validateManifest(withSecurity({ baseUrlKey: key })).valid).toBe(
        false,
      );
    }
    expect(
      validateManifest(withSecurity({ baseUrlKey: "api", auth: ["root"] }))
        .valid,
    ).toBe(false);
    expect(
      validateManifest(
        withSecurity({ baseUrlKey: "api", modes: { dev: ["nuke"] } }),
      ).valid,
    ).toBe(false);
    expect(
      validateManifest(
        withSecurity({ baseUrlKey: "api", modes: { prod: ["baseline"] } }),
      ).valid,
    ).toBe(false);
  });

  it("rejects non-http(s) and malformed host URLs", () => {
    expect(
      validateManifest(
        withSecurity({ hosts: { local: ["ftp://x.globex.localhost"] } }),
      ).valid,
    ).toBe(false);
    expect(
      validateManifest(withSecurity({ hosts: { local: ["not a url"] } })).valid,
    ).toBe(false);
  });

  it("rejects exclude regexes that are invalid or contain whitespace", () => {
    expect(
      validateManifest(withSecurity({ baseUrlKey: "api", exclude: ["(["] }))
        .valid,
    ).toBe(false);
    const spaced = validateManifest(
      withSecurity({ baseUrlKey: "api", exclude: ["/a b"] }),
    );
    expect(spaced.valid).toBe(false);
    expect(spaced.errors.map((e) => e.message).join()).toMatch(/whitespace/);
  });

  it("rejects production modes beyond the passive baseline", () => {
    const result = validateManifest(
      withSecurity({
        baseUrlKey: "api",
        modes: { production: ["baseline", "full"] },
      }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors[0].path).toContain("modes.production");
  });
});

describe("validateManifest — placement (runs, target)", () => {
  const withCore = (core: Record<string, unknown>) => ({
    name: "shop",
    services: { core },
  });
  const envs = { environments: ["local", "dev", "prod"] };

  it("accepts runs per env and a target", () => {
    const r = validateManifest(
      withCore({
        runs: { local: "remote", dev: "remote" },
        target: {
          env: "dev",
          account: "AWS",
          url: "https://api.dev.acme.example/admin/manifest",
          expect: 401,
        },
      }),
      envs,
    );
    expect(r.errors).toEqual([]);
    expect(r.valid).toBe(true);
  });

  it("accepts a list of expected codes", () => {
    expect(
      validateManifest(
        withCore({
          runs: { local: "remote" },
          target: { env: "dev", expect: [200, 401] },
        }),
        envs,
      ).valid,
    ).toBe(true);
  });

  it("rejects a runs value other than local or remote", () => {
    const r = validateManifest(withCore({ runs: { local: "cloud" } }), envs);
    expect(r.valid).toBe(false);
    expect(r.errors[0].path).toBe("services.core.runs.local");
  });

  it("rejects an unknown env name in runs", () => {
    const r = validateManifest(
      withCore({
        runs: { local: "remote", qa: "remote" },
        target: { env: "dev" },
      }),
      envs,
    );
    expect(r.valid).toBe(false);
    expect(r.errors).toEqual([
      expect.objectContaining({ path: "services.core.runs.qa" }),
    ]);
  });

  it("rejects a target.env the org does not have", () => {
    const r = validateManifest(
      withCore({ runs: { local: "remote" }, target: { env: "staging" } }),
      envs,
    );
    expect(r.valid).toBe(false);
    expect(r.errors[0].path).toBe("services.core.target.env");
  });

  it("uses the org config's environments by default", () => {
    // No org config in tests: Den's built-in environment list applies.
    expect(
      validateManifest(
        withCore({
          runs: { local: "remote", qa: "remote" },
          target: { env: "dev" },
        }),
      ).valid,
    ).toBe(false);
    expect(
      validateManifest(
        withCore({ runs: { local: "remote" }, target: { env: "staging" } }),
      ).valid,
    ).toBe(true);
  });

  it("rejects expect codes outside 100-599, non-integers and a bad url", () => {
    for (const expect_ of [99, 600, 200.5, "401", []])
      expect(
        validateManifest(
          withCore({
            runs: { local: "remote" },
            target: { env: "dev", expect: expect_ },
          }),
          envs,
        ).valid,
      ).toBe(false);
    expect(
      validateManifest(
        withCore({
          runs: { local: "remote" },
          target: { env: "dev", url: "ftp://x" },
        }),
        envs,
      ).valid,
    ).toBe(false);
  });

  it("rejects an unknown key in target", () => {
    expect(
      validateManifest(
        withCore({
          runs: { local: "remote" },
          target: { env: "dev", expected: 401 },
        }),
        envs,
      ).valid,
    ).toBe(false);
  });
});

// ── Container health checks ──────────────────────────────────────────────────

describe("validateManifest — health type container", () => {
  const withHealth = (local: Record<string, unknown>) =>
    validateManifest(
      { name: "svc", services: { db: { health: { local } } } },
      { environments: ["local"] },
    );

  it("accepts project + service (compose labels)", () => {
    const r = withHealth({
      type: "container",
      project: "acme-main",
      service: "db",
      label: "postgres",
    });
    expect(r.errors).toEqual([]);
    expect(r.valid).toBe(true);
  });

  it("accepts container_name alone", () => {
    expect(
      withHealth({ type: "container", container_name: "acme-db" }).valid,
    ).toBe(true);
  });

  it.each([
    [
      "nothing to match on",
      { type: "container" },
      'container checks need "project" and "service" (compose labels), or "container_name"',
    ],
    [
      "project without service",
      { type: "container", project: "acme-main" },
      'a container check by compose labels needs both "project" and "service"',
    ],
    [
      "service without project",
      { type: "container", service: "db" },
      'a container check by compose labels needs both "project" and "service"',
    ],
    [
      "both ways at once",
      {
        type: "container",
        project: "acme-main",
        service: "db",
        container_name: "acme-db",
      },
      'a container check matches by "project"/"service" or by "container_name", not both',
    ],
    [
      "a key of another type",
      { type: "container", container_name: "acme-db", cmd: "true" },
      'unknown key "cmd" in a container check',
    ],
  ])("rejects %s with a clear error", (_what, local, message) => {
    const r = withHealth(local);
    expect(r.valid).toBe(false);
    expect(r.errors).toEqual([
      expect.objectContaining({
        path: "services.db.health.local",
        message: expect.stringContaining(message),
      }),
    ]);
  });
});
