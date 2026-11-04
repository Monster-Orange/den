/**
 * The Local Dev graph's model (public/graph-model.js): pure and DOM-free, so
 * placement, edges, the ELK graph and action tiering are unit-testable here;
 * graph.js and panel.js own the DOM.
 */
import { describe, expect, it } from "@jest/globals";
import {
  buildElkGraph,
  buildModel,
  commandTier,
  edgeModel,
  healthLine,
  placementOf,
  repoPlacement,
  resolveActions,
} from "../../../src/ui/server/public/graph-model.js";

const row = (address: string, extra: Record<string, unknown> = {}) => {
  const [repo, service] = address.split("/");
  return {
    repo,
    service,
    address,
    repoPath: `/src/${repo}`,
    commands: ["up", "down", "restart"],
    logs: null,
    mode: "dev-managed",
    branch: "main",
    isEntrypoint: false,
    autostart: true,
    deps: [],
    cloned: true,
    manifestLayers: ["repo"],
    ...extra,
  };
};

describe("placementOf (the R13 contract, before the API sends it)", () => {
  it("a row with no runs is local, with no target", () => {
    expect(placementOf(row("shop/api"))).toEqual({
      runs: "local",
      target: null,
    });
  });

  it("a remote row keeps its target", () => {
    const target = { env: "dev", account: "Cloud", url: "https://x.example" };
    expect(placementOf(row("shop/api", { runs: "remote", target }))).toEqual({
      runs: "remote",
      target,
    });
  });

  it("only a remote row has a target; an unknown runs is local", () => {
    const target = { env: "dev" };
    expect(placementOf(row("a/b", { runs: "local", target }))).toEqual({
      runs: "local",
      target: null,
    });
    expect(placementOf(row("a/b", { runs: "none" })).runs).toBe("none");
    expect(placementOf(row("a/b", { runs: "orbit" })).runs).toBe("local");
    expect(placementOf(row("a/b", { runs: "remote" }))).toEqual({
      runs: "remote",
      target: null,
    });
  });
});

const fixture = () =>
  buildModel({
    services: [
      row("shop-web/web", { isEntrypoint: true }),
      row("shop/api", { isEntrypoint: true, deps: ["shop/db"] }),
      row("shop/worker", { deps: ["shop/db", "shop/api"] }),
      row("shop/db", { runs: "remote", target: { env: "dev" } }),
      row("billing/billing", { commands: ["up", "reset-db"] }),
    ],
    graph: {
      edges: [
        { from: "shop-web", to: "shop", kind: "http", blocking: "hard" },
        { from: "shop", to: "billing", kind: "event", blocking: "event" },
      ],
    },
    apps: [
      {
        name: "store",
        title: "Store",
        source: "declared",
        repos: ["shop-web", "shop"],
      },
    ],
    orgs: {
      orgs: [{ id: "acme", label: "Acme" }],
      repos: { "shop-web": "acme", shop: "acme", billing: "acme" },
    },
    depsMap: { "billing/billing": ["ledger"] },
    health: [
      {
        repo: "shop/api".split("/")[0],
        service: "api",
        ok: true,
        label: "ok",
        url: "http://api/health",
        openUrl: "https://api.acme.localhost",
      },
      {
        repo: "billing",
        service: "billing",
        ok: false,
        label: "down",
        url: null,
      },
    ],
  });

describe("buildModel", () => {
  it("maps /api/services rows to cards with health, app, org and placement", () => {
    const m = fixture();
    const api = m.byId.get("shop/api");
    expect(api).toMatchObject({
      id: "shop/api",
      name: "api",
      repo: "shop",
      org: "acme",
      app: "Store",
      runs: "local",
      entry: true,
      open: "https://api.acme.localhost",
      health: { ok: true, label: "ok", url: "http://api/health" },
    });
    expect(m.byId.get("billing/billing")).toMatchObject({
      app: "billing",
      missing: ["ledger"],
      health: { ok: false },
    });
    expect(m.byId.get("shop/db")?.health.ok).toBeNull();
    expect(m.mixed).toBe(true);
    expect(repoPlacement(m, "shop")).toBe("hybrid");
    expect(repoPlacement(m, "billing")).toBe("local");
  });
});

describe("buildModel: addresses as /api/services sends them", () => {
  it("a single-service repo's address is the repo; health is keyed repo/service", () => {
    const m = buildModel({
      services: [{ ...row("tasks/tasks"), address: "tasks" }],
      health: [{ repo: "tasks", service: "tasks", ok: true, label: "ok" }],
    });
    expect(m.byId.get("tasks")?.health.ok).toBe(true);
  });

  it("a bare intra-repo dep name resolves to the repo's service", () => {
    const m = buildModel({
      services: [row("shop/api", { deps: ["db"] }), row("shop/db")],
    });
    expect(m.byId.get("shop/api")?.deps).toEqual(["shop/db"]);
    expect(edgeModel(m, new Set())).toEqual([
      { from: "shop/api", to: "shop/db", kind: "intra", cross: false },
    ]);
  });
});

describe("edgeModel", () => {
  it("draws repo edges between entry services and intra-repo deps, flagging local→remote", () => {
    const edges = edgeModel(fixture(), new Set());
    expect(edges).toEqual(
      expect.arrayContaining([
        { from: "shop-web/web", to: "shop/api", kind: "hard", cross: false },
        {
          from: "shop/api",
          to: "billing/billing",
          kind: "event",
          cross: false,
        },
        { from: "shop/api", to: "shop/db", kind: "intra", cross: true },
        { from: "shop/worker", to: "shop/api", kind: "intra", cross: false },
      ]),
    );
    expect(edges).toHaveLength(5);
  });

  it("a collapsed repo is one node; its inner edges disappear", () => {
    const edges = edgeModel(fixture(), new Set(["shop"]));
    expect(edges).toEqual([
      { from: "shop-web/web", to: "repo:shop", kind: "hard", cross: false },
      { from: "repo:shop", to: "billing/billing", kind: "event", cross: false },
    ]);
  });
});

type Elk = {
  id: string;
  width?: number;
  height?: number;
  layoutOptions?: Record<string, string>;
  children?: Elk[];
  edges?: { sources: string[]; targets: string[] }[];
};
type Act = { id: string };

describe("buildElkGraph", () => {
  const find = (n: Elk, id: string): Elk | undefined =>
    n.id === id ? n : (n.children || []).map((c) => find(c, id)).find(Boolean);

  it("nests org › repo › service, real card sizes, INCLUDE_CHILDREN, orthogonal, chosen direction", () => {
    const root = buildElkGraph(fixture(), {
      direction: "right",
      group: "org",
      density: "detailed",
      collapsed: new Set(),
    });
    expect(root.layoutOptions).toMatchObject({
      "elk.algorithm": "layered",
      "elk.direction": "RIGHT",
      "elk.hierarchyHandling": "INCLUDE_CHILDREN",
      "elk.edgeRouting": "ORTHOGONAL",
    });
    const org = find(root, "grp:acme");
    expect(org).toBeTruthy();
    const shop = find(org, "rg:shop");
    expect(shop.children.map((c: Elk) => c.id)).toEqual([
      "shop/api",
      "shop/worker",
      "shop/db",
    ]);
    expect(find(org, "shop-web/web")).toMatchObject({
      width: 236,
      height: 104,
    });
    // An edge lives on its endpoints' lowest common ancestor.
    expect(
      shop.edges.map(
        (e: { sources: string[]; targets: string[] }) =>
          e.sources[0] + ">" + e.targets[0],
      ),
    ).toEqual(
      expect.arrayContaining(["shop/api>shop/db", "shop/worker>shop/api"]),
    );
    expect(
      org.edges.map(
        (e: { sources: string[]; targets: string[] }) =>
          e.sources[0] + ">" + e.targets[0],
      ),
    ).toEqual(
      expect.arrayContaining([
        "shop-web/web>shop/api",
        "shop/api>billing/billing",
      ]),
    );
  });

  it("groups by application, compact cards, collapsed repos as one card", () => {
    const root = buildElkGraph(fixture(), {
      direction: "down",
      group: "app",
      density: "compact",
      collapsed: new Set(["shop"]),
    });
    expect(root.layoutOptions["elk.direction"]).toBe("DOWN");
    expect(root.children.map((c: Elk) => c.id).sort()).toEqual([
      "grp:Store",
      "grp:billing",
    ]);
    expect(find(root, "repo:shop")).toMatchObject({ width: 176, height: 52 });
    expect(find(root, "rg:shop")).toBeUndefined();
  });
});

describe("resolveActions", () => {
  const svc = { id: "a/b" };
  const A = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    label: id,
    for: ["service"],
    tier: "common",
    when: () => true,
    run: () => {},
    ...extra,
  });

  it("primary is the first whose primaryWhen holds and is enabled; two common beside it; the rest grouped", () => {
    const r = resolveActions(
      [
        A("start", { primaryWhen: () => true, disabled: () => "runs in dev" }),
        A("open", { primaryWhen: () => true }),
        A("logs", { primaryWhen: () => true }),
        A("restart"),
        A("with-deps"),
        A("terminal", { tier: "tools" }),
        A("seed", { tier: "commands" }),
        A("stop", { tier: "danger", confirm: true }),
        A("never", { when: () => false }),
        A("repo-only", { for: ["repo"] }),
      ],
      svc,
      "service",
    );
    expect(r.primary?.id).toBe("open");
    expect(r.common.map((a: Act) => a.id)).toEqual(["start", "logs"]);
    expect(
      r.groups.map(([t, l]: [string, Act[]]) => [t, l.map((a: Act) => a.id)]),
    ).toEqual([
      ["common", ["restart", "with-deps"]],
      ["commands", ["seed"]],
      ["tools", ["terminal"]],
      ["danger", ["stop"]],
    ]);
  });

  it("no primary when none applies", () => {
    expect(resolveActions([A("x")], svc, "service").primary).toBeNull();
  });
});

describe("commandTier", () => {
  it("destructive manifest commands are Careful", () => {
    for (const c of [
      "reset-db",
      "drop",
      "wipe-cache",
      "clean",
      "destroy",
      "purge",
    ])
      expect(commandTier(c)).toBe("danger");
    for (const c of ["setup", "seed", "preflight"])
      expect(commandTier(c)).toBe("commands");
  });
});

describe("healthLine", () => {
  it("names the state and the response time", () => {
    expect(
      healthLine({ runs: "local", health: { ok: true, label: "ok", ms: 42 } }),
    ).toBe("healthy · 42 ms");
    expect(healthLine({ runs: "local", health: { ok: false, ms: 1500 } })).toBe(
      "down · 1.5 s",
    );
    expect(healthLine({ runs: "remote", health: { ok: true, ms: null } })).toBe(
      "reachable",
    );
    expect(healthLine({ runs: "local", health: { ok: null } })).toBe(
      "no health check",
    );
  });
});
