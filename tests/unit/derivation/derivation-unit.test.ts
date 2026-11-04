/**
 * Unit tests for the dependency-derivation building blocks: alias normalization,
 * the three discovery rule families, the Makefile-target parser, the per-repo
 * fingerprint cache, the file scanner, the pure graph assembler, and the
 * `den graph` renderers. All hermetic (synthetic inputs / temp dirs).
 */

import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { buildAliasResolver } from "../../../src/shared/environment-manager/derivation/alias.js";
import { SAMPLE_ALIASES } from "../fixtures/sample-topology.js";
import { deriveInfraEdges } from "../../../src/shared/environment-manager/derivation/rules-infra.js";
import { deriveHttpEdges } from "../../../src/shared/environment-manager/derivation/rules-http.js";
import { deriveEventEdges } from "../../../src/shared/environment-manager/derivation/rules-events.js";
import { deriveReadinessEdges } from "../../../src/shared/environment-manager/derivation/rules-readiness.js";
import {
  listMakeTargets,
  requireTargets,
} from "../../../src/shared/environment-manager/make-targets.js";
import {
  repoFingerprint,
  emptyCache,
} from "../../../src/shared/environment-manager/derivation/cache.js";
import {
  scanRepo,
  hasRepoMarker,
} from "../../../src/shared/environment-manager/derivation/scan.js";
import { assembleGraph } from "../../../src/shared/environment-manager/derivation/derive-graph.js";
import { readDenConfig } from "../../../src/shared/den-config.js";
import {
  edgeMatchesKind,
  diffEdges,
  renderText,
  renderDot,
  renderDiff,
  connectedComponent,
} from "../../../src/ui/cli/graph-command.js";
import type {
  DerivedEdge,
  ScannedRepo,
} from "../../../src/shared/environment-manager/derivation/types.js";

function repo(
  repoName: string,
  files: Array<{ rel: string; content: string }>,
): ScannedRepo {
  return {
    repoName,
    repoPath: `/fake/${repoName}`,
    files: files.map((f) => ({ ...f, abs: `/fake/${repoName}/${f.rel}` })),
  };
}

/** The sample org's shared local infra (graph.infra in its config). */
const SAMPLE_INFRA = {
  repo: "infra-stack",
  signals: [
    "host\\.docker\\.internal:4566",
    "localhost:4566",
    "_localstack/health",
    "/infra-stack/",
    "host\\.docker\\.internal:15432",
    "host\\.docker\\.internal:8001",
  ],
};

const alias = buildAliasResolver({
  aliases: SAMPLE_ALIASES,
  sdk_orgs: ["example-org"],
  npm_scopes: ["example"],
  infra: SAMPLE_INFRA,
});

describe("alias resolver", () => {
  it("resolves canonical names, aliases, and event sources", () => {
    expect(alias.resolve("shop")).toBe("shop");
    expect(alias.resolve("shop.backend")).toBe("shop");
    expect(alias.resolve("shop-api")).toBe("shop");
    expect(alias.resolve("job-runner")).toBe("jobs-runtime");
    expect(alias.resolve("files-sdk")).toBe("files-api");
    expect(alias.resolve("links-sdk")).toBe("links-api");
    expect(alias.resolve("token-service")).toBe("tokens");
    expect(alias.resolve("nope-unknown")).toBeNull();
    expect(alias.knownRepos.has("infra-stack")).toBe(true);
  });

  it("resolves only the narrow tool-catalog alias", () => {
    expect(alias.resolve("tool-catalog")).toBe("tasks-api");
    expect(alias.resolve("tools")).not.toBe("tasks-api");
  });

  it("merges config aliases over the built-in defaults", () => {
    const merged = buildAliasResolver({
      aliases: {
        ...SAMPLE_ALIASES,
        shop: [...SAMPLE_ALIASES.shop, "my-backend"],
      },
    });
    expect(merged.resolve("my-backend")).toBe("shop");
    expect(merged.resolve("backend")).toBe("shop"); // default preserved
  });

  it("marks repos with a `*-events` alias as event sinks", () => {
    expect(alias.eventSinks.has("notes-api")).toBe(true); // notes-events
    expect(alias.eventSinks.has("files-api")).toBe(false); // files-sdk
    expect(alias.eventSinks.has("links-api")).toBe(false);
    // A config-added `*-events` alias also flags a sink.
    const m = buildAliasResolver({
      aliases: {
        ...SAMPLE_ALIASES,
        tokens: [...SAMPLE_ALIASES.tokens, "tokens-events"],
      },
    });
    expect(m.eventSinks.has("tokens")).toBe(true);
  });
});

describe("rule A — infra", () => {
  it("emits a hard infra-stack edge on an AWS-emulator signal", () => {
    const edges = deriveInfraEdges(
      repo("files-api", [
        { rel: "stack.yml", content: "X: http://host.docker.internal:4566\n" },
      ]),
      alias,
    );
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({
      to: "infra-stack",
      kind: "infra",
      blocking: "hard",
    });
  });

  it("does not emit for infra-stack itself or when no signal present", () => {
    expect(
      deriveInfraEdges(
        repo("infra-stack", [{ rel: "stack.yml", content: ":4566" }]),
        alias,
      ),
    ).toHaveLength(0);
    expect(
      deriveInfraEdges(
        repo("shop", [{ rel: "stack.yml", content: "FOO: bar" }]),
        alias,
      ),
    ).toHaveLength(0);
  });

  it("prefers a strong endpoint signal over a bare-name mention in another file", () => {
    // Regression: shop's .den.yml mentions "infra-stack" only inside a
    // shell echo string, while apps/backend/.env carries the real :4566 wiring.
    // The evidence should cite the real reference, not the echo.
    const edges = deriveInfraEdges(
      repo("shop", [
        {
          rel: ".den.yml",
          content:
            'logs:\n  cmd: >-\n    if [ -z "$cid" ]; then echo "No container for the shared infra-stack postgres"; fi\n',
        },
        {
          rel: "apps/backend/.env",
          content:
            "RUN_LIFECYCLE_QUEUE_URL=http://host.docker.internal:4566/000000000000/q\n",
        },
      ]),
      alias,
    );
    expect(edges).toHaveLength(1);
    expect(edges[0].evidence).toContain("apps/backend/.env");
    expect(edges[0].evidence).toContain(":4566");
    expect(edges[0].evidence).not.toContain("echo");
  });

  it("still emits from a bare-name mention when that is the only signal", () => {
    const edges = deriveInfraEdges(
      repo("notes-api", [
        { rel: ".den.yml", content: "depends_on:\n  - infra-stack\n" },
      ]),
      alias,
    );
    expect(edges).toHaveLength(1);
    expect(edges[0].to).toBe("infra-stack");
  });
});

describe("rule B — http/jwks", () => {
  it("derives edges from SDK imports, env URLs, and JWKS, skipping self", () => {
    const edges = deriveHttpEdges(
      repo("files-api", [
        {
          rel: "package.json",
          content: '{"dependencies":{"@example/billing-sdk":"1"}}',
        },
        {
          rel: "go.mod",
          content: "require github.com/example-org/notes-api/sdks/go v0.1.0",
        },
        {
          rel: "stack.yml",
          content:
            "LINKS_API_URL: http://host.docker.internal:8084\nFILES_API_URL: http://files-api\nSHOP_JWKS_URL: http://shop-api/x\n",
        },
      ]),
      alias,
    );
    const pairs = edges.map((e) => `${e.to}:${e.kind}`);
    expect(pairs).toContain("billing-api:http");
    expect(pairs).toContain("notes-api:http");
    expect(pairs).toContain("links-api:http");
    expect(pairs).toContain("shop:jwks");
    expect(pairs).not.toContain("files-api:http"); // self skipped
    expect(edges.every((e) => e.blocking === "soft")).toBe(true);
  });

  it("compacts SDK evidence to name + version (npm tgz URL, go module, npm semver)", () => {
    const edges = deriveHttpEdges(
      repo("shop-web", [
        {
          rel: "package.json",
          content:
            '{"dependencies":{\n"@example/files-sdk":"https://api-specs.shop.example.dev/typescript/@example/files-sdk/example-files-sdk-0.2.18.tgz",\n"@example/billing-sdk":"^0.5.0"\n}}',
        },
        {
          rel: "go.mod",
          content: "require github.com/example-org/notes-api/sdks/go v0.1.9\n",
        },
      ]),
      alias,
    );
    const ev = Object.fromEntries(edges.map((e) => [e.to, e.evidence]));
    // No giant api-specs path — just the version.
    expect(ev["files-api"]).toContain("files-sdk 0.2.18");
    expect(ev["files-api"]).not.toContain("api-specs");
    expect(ev["files-api"]).not.toContain(".tgz");
    expect(ev["billing-api"]).toContain("billing-sdk 0.5.0");
    expect(ev["notes-api"]).toContain("0.1.9"); // go module version, no `v`, clean
    expect(ev["notes-api"]).toContain("go.mod:");
  });

  it("cites the value-bearing occurrence of an env key, not the empty declaration", () => {
    // stack.yml declares keys empty in config.defaults and fills them per-env;
    // evidence should show `TOKEN_SERVICE_URL: http://tokens`, not a bare key.
    const edges = deriveHttpEdges(
      repo("billing-api", [
        {
          rel: "stack.yml",
          content: [
            "config:",
            "  defaults:",
            '    FRONTEND_BASE: ""',
            "    TOKEN_SERVICE_URL:",
            "    SHOP_JWKS_URL:",
            "  local:",
            "    TOKEN_SERVICE_URL: http://tokens",
            "    SHOP_JWKS_URL: http://shop-api/.well-known/jwks.json",
            "    FRONTEND_BASE: http://shop-web",
            "",
          ].join("\n"),
        },
      ]),
      alias,
    );
    const ev = Object.fromEntries(
      edges
        .filter((e) => e.signal === "http:env-url")
        .map((e) => [`${e.to}:${e.kind}`, e.evidence]),
    );
    expect(ev["tokens:http"]).toContain("http://tokens");
    expect(ev["shop:jwks"]).toContain("jwks.json"); // kind mapping preserved
    expect(ev["shop-web:http"]).toContain("http://shop-web");
  });

  it("still emits an edge when a URL key only ever appears with an empty value", () => {
    const edges = deriveHttpEdges(
      repo("billing-api", [
        {
          rel: "stack.yml",
          content: "config:\n  defaults:\n    TOKEN_SERVICE_URL:\n",
        },
      ]),
      alias,
    );
    const edge = edges.find((e) => e.to === "tokens");
    expect(edge).toBeDefined();
    expect(edge?.evidence).toContain("TOKEN_SERVICE_URL");
  });

  it("derives a peer from a URL value host when the key token is generic", () => {
    const edges = deriveHttpEdges(
      repo("shop", [
        { rel: "apps/backend/.env", content: "BACKEND=http://files-api\n" },
      ]),
      alias,
    );
    expect(edges.map((e) => e.to)).toContain("files-api");
  });

  it("ignores commented-out config lines", () => {
    const edges = deriveHttpEdges(
      repo("shop", [
        {
          rel: "apps/backend/.env",
          content:
            "# FILES_API_URL=http://files-api\nNOTES_API_URL=http://notes-api\n",
        },
      ]),
      alias,
    );
    const targets = edges.map((e) => e.to);
    expect(targets).toContain("notes-api"); // real line
    expect(targets).not.toContain("files-api"); // commented out
  });

  it("go.mod: skips '// indirect' requires and replace targets", () => {
    const edges = deriveHttpEdges(
      repo("files-api", [
        {
          rel: "go.mod",
          content: [
            "module github.com/example-org/files-api",
            "",
            "require (",
            "\tgithub.com/example-org/notes-api/sdks/go v0.1.0",
            "\tgithub.com/example-org/links-api v0.2.0 // indirect",
            ")",
            "",
            "replace github.com/example-org/tokens => ../tokens",
            "",
            "replace (",
            "\tgithub.com/example-org/billing-api => ../billing-api",
            ")",
            "",
          ].join("\n"),
        },
      ]),
      alias,
    );
    const targets = edges.map((e) => e.to);
    expect(targets).toContain("notes-api"); // direct require
    expect(targets).not.toContain("links-api"); // // indirect
    expect(targets).not.toContain("tokens"); // replace target
    expect(targets).not.toContain("billing-api"); // block-form replace target
  });

  it("derives peers from Pulumi stack refs (both ref shapes)", () => {
    const edges = deriveHttpEdges(
      repo("shop", [
        {
          rel: "pulumi/__main__.py",
          content:
            "pulumi_notes_api_project_name = cfg.require('x')\nh = links_api__internal_dns_hostname\n",
        },
      ]),
      alias,
    );
    expect(edges.map((e) => e.to).sort()).toEqual(["links-api", "notes-api"]);
  });
});

describe("rule C — events", () => {
  it("derives a producer→consumer flow edge from an EventBridge rule", () => {
    const edges = deriveEventEdges(
      repo("control-plane", [
        {
          rel: "pulumi/__main__.py",
          content:
            'p = {"source": ["shop.backend"], "detail-type": ["Created"]}',
        },
      ]),
      alias,
    );
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({
      from: "shop",
      to: "control-plane",
      kind: "event",
      blocking: "soft",
    });
  });

  it("ignores wildcard source patterns and self-consumption", () => {
    expect(
      deriveEventEdges(
        repo("shop", [
          {
            rel: "infra/x.py",
            content: 'p = {"source": [{"prefix": "shop."}]}',
          },
        ]),
        alias,
      ),
    ).toHaveLength(0);
    // A rule consuming its own source produces no self-edge.
    expect(
      deriveEventEdges(
        repo("control-plane", [
          {
            rel: "infra/x.py",
            content: 'p = {"source": ["shop.control-plane"]}',
          },
        ]),
        alias,
      ),
    ).toHaveLength(0);
  });
});

describe("rule D — readiness probe", () => {
  it("emits a HARD edge for a peer referenced in a dedicated readiness handler", () => {
    const edges = deriveReadinessEdges(
      repo("files-api", [
        {
          rel: "internal/apis/health/readyz_get.go",
          content:
            'if !ping(connectionsapi.URL) { return Unhealthy("links-api") }',
        },
      ]),
      alias,
    );
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({
      to: "links-api",
      kind: "http",
      blocking: "hard",
      signal: "readiness-probe",
    });
  });

  it("ignores non-handler files and own/infra references", () => {
    // A peer mentioned outside a dedicated handler file is not a readiness edge.
    expect(
      deriveReadinessEdges(
        repo("files-api", [
          { rel: "stack.yml", content: "LINKS_API_URL: http://x" },
        ]),
        alias,
      ),
    ).toHaveLength(0);
    // Own-only readiness (today's reality) yields nothing.
    expect(
      deriveReadinessEdges(
        repo("links-api", [
          {
            rel: "internal/apis/health/readyz_get.py",
            content: "ping(db); ping(redis)",
          },
        ]),
        alias,
      ),
    ).toHaveLength(0);
  });

  it("ignores bare alias words in prose and comments (no spurious hard edges)", () => {
    // "app", "backend", "token", "links" all alias-resolve, but none may
    // mint a hard startup gate from an inline comment or a log string.
    expect(
      deriveReadinessEdges(
        repo("shop", [
          {
            rel: "internal/apis/health/readyz_get.go",
            content: [
              "ok := ping(db) // check app health, backend token, links",
              "// http://files-api:8080/readyz",
              "# legacy: billing frontend",
              "res := ping(x) // TODO: reuse shop-web checker",
              'log.Info("waiting for token from app")',
            ].join("\n"),
          },
        ]),
        alias,
      ),
    ).toHaveLength(0);
  });

  it("accepts bare words as URL hosts and multi-segment tokens anywhere", () => {
    const edges = deriveReadinessEdges(
      repo("shop", [
        {
          rel: "internal/apis/health/readyz_get.go",
          content: [
            'if !ping("http://tokens:8080/healthz") { return } // token svc',
            'if !ping("http://links-api.internal:4000/readyz") { return }',
            'if !ping(filesURL) { return Unhealthy("files-api") }',
          ].join("\n"),
        },
      ]),
      alias,
    );
    expect(edges.map((e) => e.to).sort()).toEqual([
      "files-api",
      "links-api",
      "tokens",
    ]);
    expect(edges[0]).toMatchObject({
      from: "shop",
      kind: "http",
      blocking: "hard",
      signal: "readiness-probe",
    });
  });
});

describe("make-targets", () => {
  let dir: string;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "mk-"));
    fs.writeFileSync(
      path.join(dir, "Makefile"),
      [
        "FOO := bar",
        ".PHONY: setup up down",
        "setup:\n\t@echo s",
        "up: build\n\t@echo u",
        "down:\n\t@echo d",
        "include make/extra.mk", // resolvable include
        "include $(GEN)/dyn.mk", // variable path — skipped
        "include make/extra.mk", // duplicate — skipped via seen
        "-include make/missing.mk", // absent file — readSafe null
        "",
      ].join("\n"),
    );
    fs.mkdirSync(path.join(dir, "make"));
    fs.writeFileSync(
      path.join(dir, "make", "extra.mk"),
      "deploy:\n\t@echo deploy\n",
    );
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("lists targets from the root Makefile and includes, skipping vars/.PHONY", () => {
    const { targets } = listMakeTargets(dir);
    expect(targets).toEqual(
      expect.arrayContaining(["setup", "up", "down", "deploy"]),
    );
    expect(targets).not.toContain("FOO");
    expect(targets).not.toContain(".PHONY");
  });

  it("splits required targets into present/missing", () => {
    const { present, missing } = requireTargets(dir, [
      "setup",
      "up",
      "down",
      "restart",
    ]);
    expect(present).toEqual(["setup", "up", "down"]);
    expect(missing).toEqual(["restart"]);
  });

  it("returns empty for a repo without a Makefile", () => {
    expect(
      listMakeTargets(os.tmpdir() + "/definitely-missing-xyz").targets,
    ).toEqual([]);
  });
});

describe("scan + fingerprint", () => {
  let dir: string;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "scan-"));
    fs.writeFileSync(path.join(dir, ".den.yml"), "name: x\n");
    fs.writeFileSync(path.join(dir, "Makefile"), "up:\n");
    // Dedicated health handlers (Go fixed path + Python src/* glob).
    fs.mkdirSync(path.join(dir, "internal/apis/health"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "internal/apis/health/readyz_get.go"),
      "package x\n",
    );
    fs.mkdirSync(path.join(dir, "src/xpkg/internal/apis/health"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(dir, "src/xpkg/internal/apis/health/readyz_get.py"),
      "pass\n",
    );
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("scans the allow-list incl. health handlers, and detects repo markers", () => {
    const rels = scanRepo("x", dir).files.map((f) => f.rel);
    expect(rels).toEqual(expect.arrayContaining([".den.yml", "Makefile"]));
    expect(rels).toContain("internal/apis/health/readyz_get.go");
    expect(rels).toContain("src/xpkg/internal/apis/health/readyz_get.py");
    expect(hasRepoMarker(dir)).toBe(true);
    expect(hasRepoMarker(path.join(dir, "nope"))).toBe(false);
  });

  it("fingerprint changes when an input file changes", () => {
    const a = repoFingerprint(dir);
    fs.writeFileSync(path.join(dir, "Makefile"), "up:\n\t@echo changed\n");
    const b = repoFingerprint(dir);
    expect(a).not.toBe(b);
    // v3: bumped when cache keys became checkout-scoped (multi-active
    // workspaces); bump this together with CACHE_VERSION on future changes.
    expect(emptyCache().version).toBe(3);
  });
});

describe("assembleGraph", () => {
  const edgesByRepo: Record<string, DerivedEdge[]> = {
    a: [
      {
        from: "a",
        to: "b",
        kind: "http",
        blocking: "soft",
        signal: "s",
        evidence: "e",
        confidence: "high",
      },
      {
        from: "a",
        to: "b",
        kind: "http",
        blocking: "soft",
        signal: "dup",
        evidence: "e2",
        confidence: "low",
      },
      {
        from: "a",
        to: "infra",
        kind: "infra",
        blocking: "hard",
        signal: "s",
        evidence: "e",
        confidence: "high",
      },
    ],
    b: [
      {
        from: "b",
        to: "infra",
        kind: "infra",
        blocking: "hard",
        signal: "s",
        evidence: "e",
        confidence: "high",
      },
    ],
    c: [
      {
        from: "a",
        to: "c",
        kind: "event",
        blocking: "soft",
        signal: "s",
        evidence: "e",
        confidence: "high",
      },
    ],
    infra: [],
  };
  const common = {
    knownRepos: new Set(["a", "b", "c", "infra"]),
    edgesOverride: { "a->b": "hard" as const },
    deriveEdges: (r: string) => edgesByRepo[r] ?? [],
    repoExists: () => true,
  };

  it("applies the hard override and dedupes (all scope)", () => {
    const g = assembleGraph({ scope: "all", ...common });
    const ab = g.edges.filter((e) => e.from === "a" && e.to === "b");
    expect(ab).toHaveLength(1);
    expect(ab[0].blocking).toBe("hard"); // override applied
    expect(g.nodes).toEqual(["a", "b", "c", "infra"]);
  });

  it("does not create a shop→tasks-api edge from tool-catalog registration", () => {
    const config = readDenConfig();
    const effectiveAlias = buildAliasResolver({
      ...config.graph,
      aliases: { ...SAMPLE_ALIASES, ...config.graph?.aliases },
    });
    const g = assembleGraph({
      scope: "all",
      knownRepos: effectiveAlias.knownRepos,
      edgesOverride: config.graph?.edges ?? {},
      eventSinks: effectiveAlias.eventSinks,
      deriveEdges: () => [],
      repoExists: () => true,
    });

    expect(effectiveAlias.resolve("tool-catalog")).toBe("tasks-api");
    expect(g.edges).not.toContainEqual(
      expect.objectContaining({ from: "shop", to: "tasks-api" }),
    );
  });

  it("closure follows non-event edges and excludes event-only nodes", () => {
    const g = assembleGraph({ scope: "closure", seed: "a", ...common });
    expect(g.nodes).toEqual(["b", "infra", "a"].sort());
    expect(g.nodes).not.toContain("c"); // only reachable via an event edge
  });

  it("throws when closure has no seed", () => {
    expect(() => assembleGraph({ scope: "closure", ...common })).toThrow(
      /seed/,
    );
  });

  it("collapses http+jwks duplicates and applies the ignore override", () => {
    const e = (to: string, kind: DerivedEdge["kind"]): DerivedEdge => ({
      from: "a",
      to,
      kind,
      blocking: "soft",
      signal: "s",
      evidence: "ev",
      confidence: "high",
    });
    const g = assembleGraph({
      scope: "all",
      knownRepos: new Set(["a", "b", "c"]),
      edgesOverride: { "a->c": "ignore" },
      deriveEdges: (r) =>
        r === "a" ? [e("b", "http"), e("b", "jwks"), e("c", "http")] : [],
      repoExists: () => true,
    });
    // a→b had both http and jwks (same JWKS URL) → collapsed to jwks only.
    const ab = g.edges.filter((x) => x.from === "a" && x.to === "b");
    expect(ab).toHaveLength(1);
    expect(ab[0].kind).toBe("jwks");
    // a→c marked non-ordering by the `ignore` override.
    expect(g.edges.find((x) => x.from === "a" && x.to === "c")?.ordering).toBe(
      false,
    );
  });

  it("dedupe keeps a HARD edge over a SOFT one on a (from,to,kind) collision", () => {
    const e = (
      blocking: DerivedEdge["blocking"],
      signal: string,
      confidence: DerivedEdge["confidence"],
    ): DerivedEdge => ({
      from: "a",
      to: "b",
      kind: "http",
      blocking,
      signal,
      evidence: "e",
      confidence,
    });
    const g = assembleGraph({
      scope: "all",
      knownRepos: new Set(["a", "b"]),
      edgesOverride: {},
      // Soft http edge is derived BEFORE the hard readiness edge (rule order).
      deriveEdges: (r) =>
        r === "a"
          ? [
              e("soft", "http:env-url", "high"),
              e("hard", "readiness-probe", "high"),
            ]
          : [],
      repoExists: () => true,
    });
    const ab = g.edges.filter((x) => x.from === "a" && x.to === "b");
    expect(ab).toHaveLength(1);
    expect(ab[0]).toMatchObject({
      blocking: "hard",
      signal: "readiness-probe",
    });
  });

  it("dedupe prefers hard over soft even at lower confidence", () => {
    const mk = (
      blocking: DerivedEdge["blocking"],
      confidence: DerivedEdge["confidence"],
    ): DerivedEdge => ({
      from: "a",
      to: "b",
      kind: "http",
      blocking,
      signal: blocking,
      evidence: "e",
      confidence,
    });
    const g = assembleGraph({
      scope: "all",
      knownRepos: new Set(["a", "b"]),
      edgesOverride: {},
      deriveEdges: (r) =>
        r === "a" ? [mk("soft", "high"), mk("hard", "low")] : [],
      repoExists: () => true,
    });
    const ab = g.edges.filter((x) => x.from === "a" && x.to === "b");
    expect(ab).toHaveLength(1);
    expect(ab[0].blocking).toBe("hard");
  });

  it("injects an override edge that discovery did not produce", () => {
    const g = assembleGraph({
      scope: "closure",
      seed: "a",
      knownRepos: new Set(["a", "x"]),
      edgesOverride: { "a->x": "hard" },
      deriveEdges: () => [],
      repoExists: () => true,
    });
    expect(g.nodes).toEqual(["a", "x"]);
    expect(g.edges.find((e) => e.from === "a" && e.to === "x")).toMatchObject({
      blocking: "hard",
      signal: "override:config",
    });
  });

  it("reclassifies an edge INTO an event sink as event/soft", () => {
    const g = assembleGraph({
      scope: "all",
      knownRepos: new Set(["a", "sink"]),
      edgesOverride: {},
      eventSinks: new Set(["sink"]),
      deriveEdges: (r) =>
        r === "a"
          ? [
              {
                from: "a",
                to: "sink",
                kind: "http",
                blocking: "soft",
                signal: "http:sdk-import",
                evidence: "pyproject.toml: sink-events",
                confidence: "high",
              },
            ]
          : [],
      repoExists: () => true,
    });
    const edge = g.edges.find((e) => e.from === "a" && e.to === "sink");
    expect(edge).toMatchObject({ kind: "event", blocking: "soft" });
  });

  it("an explicit hard override wins over event-sink reclassification", () => {
    const g = assembleGraph({
      scope: "all",
      knownRepos: new Set(["a", "sink"]),
      edgesOverride: { "a->sink": "hard" },
      eventSinks: new Set(["sink"]),
      deriveEdges: (r) =>
        r === "a"
          ? [
              {
                from: "a",
                to: "sink",
                kind: "http",
                blocking: "soft",
                signal: "http:sdk-import",
                evidence: "go.mod: sink",
                confidence: "high",
              },
            ]
          : [],
      repoExists: () => true,
    });
    const edge = g.edges.find((e) => e.from === "a" && e.to === "sink");
    expect(edge).toMatchObject({ kind: "http", blocking: "hard" });
  });

  it("a synthetic override edge into an event sink stays hard", () => {
    const g = assembleGraph({
      scope: "closure",
      seed: "a",
      knownRepos: new Set(["a", "sink"]),
      edgesOverride: { "a->sink": "hard" },
      eventSinks: new Set(["sink"]),
      deriveEdges: () => [],
      repoExists: () => true,
    });
    const edge = g.edges.find((e) => e.from === "a" && e.to === "sink");
    expect(edge).toMatchObject({
      kind: "http",
      blocking: "hard",
      signal: "override:config",
    });
  });
});

describe("graph renderers", () => {
  const graph = {
    nodes: ["a", "b"],
    edges: [
      {
        from: "a",
        to: "b",
        kind: "http" as const,
        blocking: "hard" as const,
        signal: "s",
        evidence: "f:1",
        confidence: "high" as const,
      },
      {
        from: "a",
        to: "b",
        kind: "event" as const,
        blocking: "soft" as const,
        signal: "s",
        evidence: "f:2",
        confidence: "high" as const,
      },
    ],
  };

  it("edgeMatchesKind filters correctly", () => {
    expect(edgeMatchesKind(graph.edges[0], "all")).toBe(true);
    expect(edgeMatchesKind(graph.edges[0], "hard")).toBe(true);
    expect(edgeMatchesKind(graph.edges[1], "hard")).toBe(false);
    expect(edgeMatchesKind(graph.edges[0], "http")).toBe(true);
    expect(edgeMatchesKind(graph.edges[1], "event")).toBe(true);
    expect(edgeMatchesKind(graph.edges[0], "infra")).toBe(false);
  });

  it("renders text and dot", () => {
    const text = renderText(graph);
    expect(text).toContain("a");
    expect(text).toContain("→ b");
    expect(text).toContain("[http/hard]");
    const dot = renderDot(graph);
    expect(dot).toContain("digraph den");
    expect(dot).toContain('"a" -> "b"');
  });

  it("renders per-node boot-location annotations on the node header", () => {
    const text = renderText(graph, {
      annotations: new Map([["a", "start: den (.den-services/a/main)"]]),
    });
    expect(text).toContain("a  start: den (.den-services/a/main)");
  });

  it("diffs derived vs declared and renders both states", () => {
    const derived = [graph.edges[0]]; // a->b (sync)
    const declared: DerivedEdge[] = [
      {
        from: "a",
        to: "c",
        kind: "http",
        blocking: "soft",
        signal: "declared:depends_on",
        evidence: "x",
        confidence: "high",
      },
    ];
    const diffs = diffEdges(derived, declared, ["a", "b", "c"]);
    const a = diffs.find((d) => d.repo === "a")!;
    expect(a.undeclared).toContain("b"); // derived but not declared
    expect(a.stale).toContain("c"); // declared but not derived
    expect(renderDiff(diffs)).toContain("a");
    expect(renderDiff([])).toContain("✓");
  });

  it("connectedComponent follows event edges undirected and drops islands", () => {
    const ev = (from: string, to: string): DerivedEdge => ({
      from,
      to,
      kind: "event",
      blocking: "soft",
      signal: "s",
      evidence: "e",
      confidence: "high",
    });
    const g = {
      nodes: ["seed", "cp", "cr", "island"],
      edges: [ev("seed", "cp"), ev("cp", "cr")],
    };
    const comp = connectedComponent(g, "seed");
    expect(comp.nodes.sort()).toEqual(["cp", "cr", "seed"]);
    expect(comp.nodes).not.toContain("island");
  });
});

describe("alias resolver — catalogued repos", () => {
  it("knows every catalogued repo even with no aliases configured", () => {
    const r = buildAliasResolver({}, ["hooli-app", "hooli-design"]);
    expect([...r.knownRepos].sort()).toEqual(["hooli-app", "hooli-design"]);
    expect(r.resolve("hooli-app")).toBe("hooli-app");
  });
});
