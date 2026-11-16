/**
 * Issue 208: the `verify:` block in a repo's manifest (VERIFY-SPEC
 * section 3). Modules are `<layer>/<name>`, each with a kind, the
 * environments it may run on, a `cost` and `watch` paths. A bad block
 * fails validation with an error that names the module and says what to
 * write instead. Invented names only.
 */
import { describe, expect, it } from "@jest/globals";
import { validateManifest } from "../../../src/shared/manifest/validate-manifest.js";
import { readVerifyModules } from "../../../src/shared/verify/config.js";

const ENVS = ["local", "staging", "production"];

function check(verify: unknown) {
  return validateManifest({ name: "shop", verify }, { environments: ENVS });
}

/** The error messages, as "path: message". */
function errors(verify: unknown): string[] {
  return check(verify).errors.map((e) => `${e.path}: ${e.message}`);
}

const GOOD = {
  layers: { web: { depends_on: ["api"] }, api: {}, code: {} },
  modules: {
    "web/smoke": { kind: "smoke" },
    "web/checkout": {
      kind: "synthetic",
      playwright: { config: "e2e/playwright.config.ts" },
      environments: ["local", "staging", "production"],
    },
    "api/orders": {
      kind: "integration",
      cmd: "make contract-test",
      results: "reports/junit.xml",
      environments: ["local", "staging"],
      cost: "heavy",
      watch: ["api/src/**", "openapi.yml"],
    },
    "code/deps": { kind: "security", trivy: { scan: "fs" }, fail_on: "high" },
  },
};

describe("the verify: block", () => {
  it("accepts the spec's block", () => {
    const r = check(GOOD);
    expect(r.errors).toEqual([]);
    expect(r.valid).toBe(true);
  });

  it("a module's name is <layer>/<name>", () => {
    expect(errors({ modules: { checkout: { kind: "smoke" } } })).toEqual([
      expect.stringMatching(
        /^verify\.modules\.checkout: a module's name is <layer>\/<name>, like web\/checkout/,
      ),
    ]);
  });

  it("the kind is one of the five", () => {
    expect(
      errors({ modules: { "web/x": { kind: "unit", cmd: "true" } } }),
    ).toEqual([
      expect.stringMatching(
        /^verify\.modules\.web\/x\.kind: .*smoke, integration, synthetic, security, performance/,
      ),
    ]);
  });

  it("a module other than smoke needs cmd or one adapter", () => {
    expect(
      errors({ modules: { "api/orders": { kind: "integration" } } }),
    ).toEqual([
      expect.stringMatching(
        /^verify\.modules\.api\/orders: an integration module needs cmd or an adapter/,
      ),
    ]);
    expect(
      errors({
        modules: {
          "api/orders": {
            kind: "integration",
            cmd: "make test",
            playwright: { config: "p.ts" },
          },
        },
      }),
    ).toEqual([
      expect.stringMatching(
        /^verify\.modules\.api\/orders: give one way to run it.*cmd, playwright/,
      ),
    ]);
  });

  it("environments are the org's", () => {
    expect(
      errors({
        modules: { "web/smoke": { kind: "smoke", environments: ["qa"] } },
      }),
    ).toEqual([
      expect.stringMatching(
        /^verify\.modules\.web\/smoke\.environments: there is no environment "qa" \(environments: local, staging, production\)/,
      ),
    ]);
  });

  it("cost is cheap, medium or heavy; watch is paths in the repo", () => {
    const out = errors({
      modules: {
        "web/speed": {
          kind: "performance",
          cmd: "k6 run x.js",
          cost: "huge",
          watch: ["/etc/passwd", "../other/**"],
        },
      },
    });
    expect(out).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /^verify\.modules\.web\/speed\.cost: .*cheap, medium, heavy/,
        ),
      ]),
    );
    const v = errors({
      modules: {
        "web/speed": {
          kind: "performance",
          cmd: "k6 run x.js",
          watch: ["/etc/passwd", "../other/**"],
        },
      },
    });
    expect(v).toEqual([
      expect.stringMatching(
        /^verify\.modules\.web\/speed\.watch\[0\]: a watch path is inside the repo/,
      ),
      expect.stringMatching(
        /^verify\.modules\.web\/speed\.watch\[1\]: a watch path is inside the repo/,
      ),
    ]);
  });

  it("an unknown key is named", () => {
    expect(
      errors({ modules: { "web/smoke": { kind: "smoke", wach: ["x"] } } }),
    ).toEqual([
      expect.stringMatching(/^verify\.modules\.web\/smoke: .*"wach"/),
    ]);
  });

  it("depends_on names a layer, and layers don't depend in a circle", () => {
    expect(
      errors({ layers: { web: { depends_on: ["db"] } }, modules: {} }),
    ).toEqual([
      expect.stringMatching(
        /^verify\.layers\.web\.depends_on: there is no layer "db"/,
      ),
    ]);
    expect(
      errors({
        layers: { web: { depends_on: ["api"] }, api: { depends_on: ["web"] } },
      }),
    ).toEqual([
      expect.stringMatching(/^verify\.layers: the layers depend in a circle: /),
    ]);
  });

  it("a code scanner is a security module", () => {
    expect(
      errors({ modules: { "code/deps": { kind: "smoke", trivy: {} } } }),
    ).toEqual([
      expect.stringMatching(
        /^verify\.modules\.code\/deps: trivy scans the code: its kind is security/,
      ),
    ]);
  });
});

describe("readVerifyModules", () => {
  it("each module with its repo, layer, kind, adapter and defaults", () => {
    const r = readVerifyModules({
      repo: "shop",
      repoPath: "/tmp/shop",
      manifest: { name: "shop", verify: GOOD },
    });
    expect(r.errors).toEqual([]);
    const byName = Object.fromEntries(r.modules.map((m) => [m.name, m]));
    expect(byName["api/orders"]).toMatchObject({
      id: "shop:api/orders",
      repo: "shop",
      layer: "api",
      kind: "integration",
      adapter: "cmd",
      environments: ["local", "staging"],
      cost: "heavy",
      watch: ["api/src/**", "openapi.yml"],
    });
    // The defaults: local only; a code scan on every environment.
    expect(byName["web/smoke"]).toMatchObject({
      adapter: "smoke",
      environments: ["local"],
    });
    expect(byName["code/deps"]).toMatchObject({
      adapter: "trivy",
      environments: "all",
    });
    expect(r.layers).toEqual({ web: ["api"], api: [], code: [] });
  });
});
