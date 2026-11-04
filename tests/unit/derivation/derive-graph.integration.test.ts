/**
 * End-to-end derivation test over a fixture sibling-repo tree.
 *
 * Sets DEN_ROOT to a temp den dir (with config/den.yml repos_root +
 * edge overrides) and builds fake repos so `deriveGraph` and `cmdGraph` exercise
 * the real path: config + alias + per-repo cache + rules + closure/all + the
 * central hard override + make-target annotations.
 */

import { describe, it, expect, beforeAll, afterAll, jest } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { sampleAliasesYaml } from "../fixtures/sample-topology.js";
import type { DerivedGraph } from "../../../src/shared/environment-manager/derivation/types.js";

let tmp: string;
let distRoot: string;
let deriveGraph: (opts: {
  scope: "all" | "closure";
  seed?: string;
  refresh?: boolean;
  workspace?: string;
}) => DerivedGraph;
let cmdGraph: (args: string[]) => Promise<void>;
let renderTargetWarnings: (nodes: string[]) => string;

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function findEdge(g: DerivedGraph, from: string, to: string) {
  return g.edges.find((e) => e.from === from && e.to === to);
}

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "den-graph-e2e-"));
  distRoot = path.join(tmp, "den");
  const repos = path.join(tmp, "repos");

  write(path.join(distRoot, "den.yml"), "product:\n  name: den\n");
  write(
    path.join(distRoot, "config", "den.yml"),
    [
      "repos_root: ../repos",
      "graph:",
      ...sampleAliasesYaml(),
      "  infra:",
      "    repo: infra-stack",
      '    signals: ["host\\\\.docker\\\\.internal:4566", "localhost:4566", "_localstack/health"]',
      "  edges:",
      '    "files-api->links-api": hard',
      '    "shop->links-api": hard',
      "",
    ].join("\n"),
  );
  fs.mkdirSync(path.join(distRoot, "config", "local"), { recursive: true });

  const mk = "setup:\n\t@echo s\nup:\n\t@echo u\ndown:\n\t@echo d\n";
  // infra-stack — foundation, leaf.
  write(path.join(repos, "infra-stack", "Makefile"), mk);
  // links-api — leaf service, only the shared infra dep.
  write(path.join(repos, "links-api", "Makefile"), mk);
  write(
    path.join(repos, "links-api", "stack.yml"),
    "KMS_ENDPOINT_URL: http://host.docker.internal:4566\n",
  );
  // files-api — links (override hard) + notes (sdk) + infra.
  write(path.join(repos, "files-api", "Makefile"), mk);
  write(
    path.join(repos, "files-api", "stack.yml"),
    "LINKS_API_URL: http://host.docker.internal:8084\nS3_ENDPOINT: http://host.docker.internal:4566\n",
  );
  write(
    path.join(repos, "files-api", "pyproject.toml"),
    'deps = ["notes-events==0.1", "links-sdk==0.1"]\n',
  );
  write(
    path.join(repos, "files-api", ".den.yml"),
    "name: files-api\nservices:\n  api:\n    depends_on:\n      - links-api\n      - infra-stack\n",
  );
  // notes-api — jwks→shop + infra.
  write(path.join(repos, "notes-api", "Makefile"), mk);
  write(
    path.join(repos, "notes-api", "stack.yml"),
    "SHOP_JWKS_URL: http://shop-api/.well-known/jwks.json\nSQS_ENDPOINT: http://host.docker.internal:4566\n",
  );
  // shop — links (override hard) + files + infra.
  write(path.join(repos, "shop", "Makefile"), mk);
  write(
    path.join(repos, "shop", "apps", "backend", ".env"),
    "LINKS_API_URL=http://links-api\nFILES_API_URL=http://files-api\nAWS_ENDPOINT_URL=http://host.docker.internal:4566\n",
  );
  // control-plane — NO .den.yml, Makefile missing `down`, event rule + http→shop.
  write(
    path.join(repos, "control-plane", "Makefile"),
    "setup:\n\t@echo s\nup:\n\t@echo u\n",
  );
  write(
    path.join(repos, "control-plane", "stack.yml"),
    "SHOP_BACKEND_INTERNAL_URL: http://shop-api\n",
  );
  write(
    path.join(repos, "control-plane", "pulumi", "__main__.py"),
    'rule = {"source": ["shop.backend"], "detail-type": ["Created"]}\n',
  );
  // tokens — Makefile WITHOUT `down`, but .den.yml declares `down: opctl kill`,
  // so the manifest command satisfies the down requirement (not flagged).
  write(
    path.join(repos, "tokens", "Makefile"),
    "setup:\n\t@echo s\nup:\n\t@echo u\n",
  );
  write(
    path.join(repos, "tokens", ".den.yml"),
    "name: tokens\nservices:\n  api:\n    commands:\n      local:\n        up: make up\n        down: opctl kill\n        setup: make setup\n",
  );

  // billing-api exists ONLY inside per-workspace checkouts (no sibling), so it
  // is visible to derivation exactly when the graph is derived against the
  // workspace that links it.
  write(path.join(tmp, "ws-billing", "billing-api", "Makefile"), mk);
  write(
    path.join(tmp, "ws-billing", "billing-api", "stack.yml"),
    "SQS_ENDPOINT: http://host.docker.internal:4566\n",
  );
  write(
    path.join(distRoot, "config", "local", "service-catalog.yml"),
    "billing-api:\n  gh: Globex-Corp/billing-api\n",
  );
  write(
    path.join(distRoot, "config", "local", "workspaces.yml"),
    [
      "active:",
      "  - billing",
      "  - plain",
      "focus: plain",
      "workspaces:",
      "  billing:",
      "    services:",
      "      billing-api:",
      "        mode: dev-managed",
      `        path: ${path.join(tmp, "ws-billing", "billing-api")}`,
      "  plain:",
      "    services: {}",
      "",
    ].join("\n"),
  );

  process.env.DEN_ROOT = distRoot;
  delete process.env.DEN_INVOKE_CWD;
  ({ deriveGraph } =
    await import("../../../src/shared/environment-manager/derivation/derive-graph.js"));
  ({ cmdGraph, renderTargetWarnings } =
    await import("../../../src/ui/cli/graph-command.js"));
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  delete process.env.DEN_ROOT;
});

describe("deriveGraph (all)", () => {
  it("derives the expected nodes and edges with correct kind/blocking", () => {
    const g = deriveGraph({ scope: "all", refresh: true });

    expect(g.nodes).toEqual(
      expect.arrayContaining([
        "infra-stack",
        "links-api",
        "files-api",
        "notes-api",
        "shop",
        "control-plane",
      ]),
    );

    expect(findEdge(g, "links-api", "infra-stack")).toMatchObject({
      kind: "infra",
      blocking: "hard",
    });
    expect(findEdge(g, "files-api", "links-api")).toMatchObject({
      kind: "http",
      blocking: "hard",
    });
    // notes-api is an event sink (its `notes-events` SDK publishes events), so
    // an SDK edge into it is reclassified from http to event (soft, non-gating).
    expect(findEdge(g, "files-api", "notes-api")).toMatchObject({
      kind: "event",
      blocking: "soft",
    });
    expect(findEdge(g, "shop", "links-api")).toMatchObject({
      blocking: "hard",
    });
    expect(
      g.edges.some(
        (e) => e.from === "notes-api" && e.to === "shop" && e.kind === "jwks",
      ),
    ).toBe(true);
    expect(findEdge(g, "shop", "control-plane")).toMatchObject({
      kind: "event",
    });
    expect(findEdge(g, "control-plane", "shop")).toMatchObject({
      kind: "http",
    });
  });

  it("writes the per-repo cache and re-derives on refresh", () => {
    deriveGraph({ scope: "all" });
    expect(
      fs.existsSync(
        path.join(distRoot, "config", "local", ".graph-cache.json"),
      ),
    ).toBe(true);
    // Warm run returns the same graph.
    const warm = deriveGraph({ scope: "all" });
    expect(warm.edges.length).toBeGreaterThan(0);
  });

  it("ignores a cache file written by an incompatible version", () => {
    write(
      path.join(distRoot, "config", "local", ".graph-cache.json"),
      JSON.stringify({ version: 999, repos: {} }),
    );
    const g = deriveGraph({ scope: "all" }); // non-refresh → reads the stale cache, must discard it
    expect(g.edges.length).toBeGreaterThan(0);
  });
});

describe("deriveGraph (workspace-scoped)", () => {
  it("resolves repos against the named workspace, not the focused one", () => {
    const scoped = deriveGraph({
      scope: "all",
      workspace: "billing",
      refresh: true,
    });
    expect(scoped.nodes).toContain("billing-api");
    expect(findEdge(scoped, "billing-api", "infra-stack")).toMatchObject({
      kind: "infra",
      blocking: "hard",
    });

    // Focus is "plain", which links no checkout for billing-api — deriving
    // against it (explicitly or by default) leaves the repo out entirely.
    for (const g of [
      deriveGraph({ scope: "all", workspace: "plain", refresh: true }),
      deriveGraph({ scope: "all", refresh: true }),
    ]) {
      expect(g.nodes).not.toContain("billing-api");
      expect(findEdge(g, "billing-api", "infra-stack")).toBeUndefined();
    }
  });

  it("falls back to the focused workspace for an unknown workspace name", () => {
    const g = deriveGraph({ scope: "all", workspace: "nope", refresh: true });
    expect(g.nodes).not.toContain("billing-api");
    expect(g.nodes).toContain("shop");
  });
});

describe("deriveGraph (closure)", () => {
  it("includes the seed's transitive sync deps but excludes event-only nodes", () => {
    const g = deriveGraph({
      scope: "closure",
      seed: "files-api",
      refresh: true,
    });
    expect(g.nodes).toEqual(
      expect.arrayContaining([
        "files-api",
        "links-api",
        "notes-api",
        "shop",
        "infra-stack",
      ]),
    );
    // control-plane is only reachable from shop via an event edge → not in the closure.
    expect(g.nodes).not.toContain("control-plane");
  });
});

describe("cmdGraph", () => {
  it("renders text with make-target gaps, JSON, and diff", async () => {
    const log = jest.spyOn(console, "log").mockImplementation(() => {});
    try {
      await cmdGraph(["--all", "--refresh"]);
      const text = log.mock.calls.map((c) => String(c[0])).join("\n");
      expect(text).toContain("den dependency graph");
      // control-plane has no .den.yml and no `make down` → flagged.
      expect(text).toContain("control-plane: missing down");
      // tokens lacks `make down` but declares `down: opctl kill` → NOT flagged.
      expect(text).not.toContain("tokens: missing");
      expect(text).toContain("sibling repo"); // boot-location annotation

      log.mockClear();
      await cmdGraph(["--all", "--format=json"]);
      const json = JSON.parse(log.mock.calls.map((c) => String(c[0])).join(""));
      expect(json.nodes).toContain("shop");
      expect(Array.isArray(json.edges)).toBe(true);

      log.mockClear();
      await cmdGraph(["--all", "--diff"]);
      const diff = log.mock.calls.map((c) => String(c[0])).join("\n");
      expect(diff).toContain("notes-api"); // derived but not declared

      log.mockClear();
      await cmdGraph(["--all", "--format=dot"]);
      expect(log.mock.calls.map((c) => String(c[0])).join("")).toContain(
        "digraph den",
      );

      log.mockClear();
      await cmdGraph(["--all", "-d"]);
      expect(log.mock.calls.map((c) => String(c[0])).join("\n")).toContain(
        "order: down",
      );

      log.mockClear();
      await cmdGraph(["--all", "--source=declared"]);
      await cmdGraph(["--all", "--source=union", "--kind=hard"]);
      expect(log).toHaveBeenCalled();

      // Seed graph = the connected neighborhood (incl. event-reachable nodes),
      // with per-node boot-location annotations.
      log.mockClear();
      await cmdGraph(["links-api"]);
      const nb = log.mock.calls.map((c) => String(c[0])).join("\n");
      expect(nb).toContain("neighborhood: links-api");
      expect(nb).toContain("sibling repo (../repos/links-api)");
      // The "all good" make-target branch (node set where every repo has down).
      expect(renderTargetWarnings(["infra-stack", "links-api"])).toContain(
        "setup/up/down ✓",
      );
    } finally {
      log.mockRestore();
    }
  });
});
