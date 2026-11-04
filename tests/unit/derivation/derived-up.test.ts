/**
 * Unit tests for derived startup ordering (orderForUp / orderForDown /
 * hardDepsOf): infra-stack first, hard edges constrain sequence, soft + event
 * edges don't, seed excluded unless included, and hard cycles degrade safely.
 */

import { describe, it, expect } from "@jest/globals";
import {
  startClosure,
  deriveStartTargets,
  filterClosureForStart,
  orderForUp,
  orderForDown,
  hardDepsOf,
  restrictGraph,
} from "../../../src/shared/environment-manager/derivation/derived-up.js";
import type {
  DerivedEdge,
  DerivedGraph,
} from "../../../src/shared/environment-manager/derivation/types.js";

function edge(
  from: string,
  to: string,
  kind: DerivedEdge["kind"],
  blocking: DerivedEdge["blocking"],
): DerivedEdge {
  return {
    from,
    to,
    kind,
    blocking,
    signal: "s",
    evidence: "e",
    confidence: "high",
  };
}

const graph: DerivedGraph = {
  nodes: ["links-api", "infra-stack", "files-api", "shop", "notes-api"],
  edges: [
    edge("files-api", "links-api", "http", "hard"),
    edge("files-api", "infra-stack", "infra", "hard"),
    edge("links-api", "infra-stack", "infra", "hard"),
    edge("shop", "links-api", "http", "hard"),
    edge("shop", "files-api", "http", "soft"),
    edge("shop", "notes-api", "http", "soft"),
    edge("notes-api", "shop", "jwks", "soft"),
  ],
};

const idx = (order: string[], n: string) => order.indexOf(n);

describe("orderForUp", () => {
  it("places a sink-only consumer in its dependency's band, not with the roots (tasks-api regression)", () => {
    // tasks-api depends ONLY on infra-stack, and nothing depends on it.
    // Before the layer-aware tie-break, the Kahn ready queue sorted by name
    // alone, and "tasks-api" losing alphabetically to every other repo pushed
    // it to the END of the up-order — which is the TOP of the display order,
    // parked next to shop-web instead of beside the one thing it depends on.
    const g: DerivedGraph = {
      nodes: [...graph.nodes, "tasks-api", "shop-web"],
      edges: [
        ...graph.edges,
        edge("tasks-api", "infra-stack", "infra", "hard"),
        edge("shop-web", "shop", "http", "hard"),
      ],
    };
    const up = orderForUp(g);
    // Same layer as the other infra-only consumers — well before the deep
    // consumers, despite sorting last alphabetically.
    expect(idx(up, "tasks-api")).toBeGreaterThan(idx(up, "infra-stack"));
    expect(idx(up, "tasks-api")).toBeLessThan(idx(up, "files-api"));
    expect(idx(up, "tasks-api")).toBeLessThan(idx(up, "shop"));
    expect(idx(up, "tasks-api")).toBeLessThan(idx(up, "shop-web"));
    // Display order (reverse): near infra-stack at the bottom, and shop-web
    // stays at the very top.
    const down = orderForDown(g);
    expect(down[0]).toBe("shop-web");
    expect(idx(down, "tasks-api")).toBeGreaterThan(idx(down, "shop"));
    expect(idx(down, "tasks-api")).toBeLessThan(idx(down, "infra-stack"));
  });

  it("puts infra-stack first and respects hard edges, excluding the seed", () => {
    const order = orderForUp(graph, { seed: "shop" });
    expect(order).not.toContain("shop"); // seed excluded by default
    expect(idx(order, "infra-stack")).toBeLessThan(idx(order, "links-api"));
    expect(idx(order, "links-api")).toBeLessThan(idx(order, "files-api"));
    expect(order).toContain("notes-api"); // soft-only dep still started
  });

  it("includes the seed with include:true, ordered after its hard deps", () => {
    const order = orderForUp(graph, { seed: "shop", include: true });
    expect(order).toContain("shop");
    expect(idx(order, "links-api")).toBeLessThan(idx(order, "shop"));
  });

  it("orders deps-first over soft edges, putting aggregators last (cycle-safe)", () => {
    // shop ⇄ notes (soft cycle); shop also → links (higher out-degree).
    const g: DerivedGraph = {
      nodes: ["shop", "notes-api", "links-api", "infra-stack"],
      edges: [
        edge("shop", "notes-api", "http", "soft"),
        edge("notes-api", "shop", "jwks", "soft"),
        edge("shop", "links-api", "http", "soft"),
        edge("links-api", "infra-stack", "infra", "hard"),
        edge("shop", "infra-stack", "infra", "hard"),
      ],
    };
    const order = orderForUp(g, { include: true });
    expect(order[0]).toBe("infra-stack"); // infra first
    expect(idx(order, "links-api")).toBeLessThan(idx(order, "shop"));
    expect(idx(order, "notes-api")).toBeLessThan(idx(order, "shop")); // aggregator last
  });

  it("excludes jwks and ordering:false edges from the order", () => {
    // A normal http dep orders the target first.
    expect(
      orderForUp({
        nodes: ["x", "y"],
        edges: [edge("x", "y", "http", "soft")],
      }),
    ).toEqual(["y", "x"]);
    // jwks (auth) does not constrain order → alphabetical.
    expect(
      orderForUp({
        nodes: ["x", "y"],
        edges: [edge("x", "y", "jwks", "soft")],
      }),
    ).toEqual(["x", "y"]);
    // ordering:false (e.g. an `ignore` override) does not constrain order either.
    expect(
      orderForUp({
        nodes: ["x", "y"],
        edges: [{ ...edge("x", "y", "http", "soft"), ordering: false }],
      }),
    ).toEqual(["x", "y"]);
  });

  it("treats an http back-call against an event flow as non-ordering", () => {
    // shop →(event) control-plane →(event) jobs-runtime, and compute calls
    // shop back (http). The back-call must not gate order, so event consumers
    // start before the producer they listen to.
    const g: DerivedGraph = {
      nodes: ["shop", "control-plane", "jobs-runtime"],
      edges: [
        edge("shop", "control-plane", "event", "soft"),
        edge("control-plane", "jobs-runtime", "event", "soft"),
        edge("jobs-runtime", "shop", "http", "soft"),
      ],
    };
    const order = orderForUp(g);
    expect(idx(order, "jobs-runtime")).toBeLessThan(idx(order, "shop"));
    expect(idx(order, "control-plane")).toBeLessThan(idx(order, "shop"));
  });

  it("degrades to the node list on a hard cycle instead of throwing", () => {
    const cyclic: DerivedGraph = {
      nodes: ["a", "b"],
      edges: [edge("a", "b", "http", "hard"), edge("b", "a", "http", "hard")],
    };
    expect(() => orderForUp(cyclic)).not.toThrow();
    expect(orderForUp(cyclic).sort()).toEqual(["a", "b"]);
  });
});

describe("orderForDown", () => {
  it("is the reverse of the full startup order and includes the seed", () => {
    const down = orderForDown(graph);
    expect(down).toContain("shop");
    // dependents stop before dependencies → infra-stack is last.
    expect(idx(down, "shop")).toBeLessThan(idx(down, "infra-stack"));
    expect(idx(down, "files-api")).toBeLessThan(idx(down, "links-api"));
  });
});

describe("restrictGraph", () => {
  // seed → a (http); a ⇢ b (event); c → seed (http, upstream caller).
  const g: DerivedGraph = {
    nodes: ["seed", "a", "b", "c"],
    edges: [
      edge("seed", "a", "http", "soft"),
      edge("a", "b", "event", "soft"),
      edge("c", "seed", "http", "soft"),
    ],
  };

  it("keeps only nodes/edges within the set", () => {
    const sub = restrictGraph(g, new Set(["seed", "a", "b"]));
    expect(sub.nodes.sort()).toEqual(["a", "b", "seed"]);
    expect(sub.edges.some((e) => e.from === "c" || e.to === "c")).toBe(false);
  });
});

describe("startClosure — the Jul 14 incident replay", () => {
  // `den up notes-api` once started notes PLUS files-api,
  // jobs-runtime, control-plane, shop and shop-web: its only path to that
  // set is a tolerant JWKS auth edge to shop, and following it dragged in
  // shop's whole neighborhood. Kept as a regression fixture — the positional
  // rule now refuses shop because it ranks ABOVE notes-api, so the blowup is
  // impossible by construction rather than by a per-kind special case.
  const incident: DerivedGraph = {
    nodes: [
      "links-api",
      "infra-stack",
      "notes-api",
      "files-api",
      "jobs-runtime",
      "control-plane",
      "shop",
      "shop-web",
    ],
    edges: [
      edge("notes-api", "infra-stack", "infra", "hard"),
      edge("notes-api", "links-api", "http", "hard"),
      edge("notes-api", "shop", "jwks", "soft"),
      edge("links-api", "infra-stack", "infra", "hard"),
      // shop's neighborhood — must stay untouched by `up notes-api`
      edge("shop", "infra-stack", "infra", "hard"),
      edge("shop", "links-api", "http", "hard"),
      edge("shop", "files-api", "http", "soft"),
      edge("shop", "shop-web", "http", "soft"),
      edge("shop", "control-plane", "event", "soft"),
      edge("control-plane", "jobs-runtime", "event", "soft"),
      edge("control-plane", "shop", "http", "soft"),
      edge("jobs-runtime", "files-api", "http", "soft"),
      edge("files-api", "notes-api", "event", "soft"),
    ],
  };

  it("starts ONLY the seed and what sits below it — not its JWKS provider's world", () => {
    const { order } = deriveStartTargets(incident, "notes-api");
    expect([...order].sort()).toEqual([
      "infra-stack",
      "links-api",
      "notes-api",
    ]);
    expect(idx(order, "infra-stack")).toBeLessThan(idx(order, "notes-api"));
    expect(idx(order, "links-api")).toBeLessThan(idx(order, "notes-api"));
  });

  it("`-x` starts just the dependencies (no seed, still no JWKS blowup)", () => {
    const { order } = deriveStartTargets(incident, "notes-api", false);
    expect([...order].sort()).toEqual(["infra-stack", "links-api"]);
  });

  it("does not follow the files-api → notes-api event edge upward", () => {
    // files-api ranks ABOVE notes-api, so starting notes must not pull
    // its event consumer in — the inverse of the files-api case, where the
    // same kind of edge points DOWN and is followed.
    expect(startClosure(incident, "notes-api").has("files-api")).toBe(false);
  });
});

describe("derived down — same closure as up, reversed", () => {
  // Same incident fixture. `den down` used to walk to DEPENDENTS; it now
  // tears down exactly what `den up <seed>` brings up, so the pair operates
  // on one set. The JWKS edge must still not drag shop's world in — here that
  // falls out of the positional rule rather than a per-kind exclusion.
  const incident: DerivedGraph = {
    nodes: [
      "links-api",
      "infra-stack",
      "notes-api",
      "files-api",
      "jobs-runtime",
      "control-plane",
      "shop",
      "shop-web",
    ],
    edges: [
      edge("notes-api", "infra-stack", "infra", "hard"),
      edge("notes-api", "links-api", "http", "hard"),
      edge("notes-api", "shop", "jwks", "soft"),
      edge("links-api", "infra-stack", "infra", "hard"),
      edge("shop", "infra-stack", "infra", "hard"),
      edge("shop", "links-api", "http", "hard"),
      edge("shop", "files-api", "http", "soft"),
      edge("shop-web", "shop", "http", "hard"),
      edge("shop", "control-plane", "event", "soft"),
      edge("control-plane", "jobs-runtime", "event", "soft"),
      edge("control-plane", "shop", "http", "soft"),
      edge("jobs-runtime", "files-api", "http", "soft"),
      edge("files-api", "notes-api", "event", "soft"),
    ],
  };

  it("tears down exactly the set up brings up, seed first", () => {
    const up = deriveStartTargets(incident, "notes-api").order;
    const down = [...up].reverse();
    expect([...up].sort()).toEqual(["infra-stack", "links-api", "notes-api"]);
    expect(down[0]).toBe("notes-api");
    expect(down[down.length - 1]).toBe("infra-stack");
  });

  it("still refuses the JWKS provider's world", () => {
    const closure = startClosure(incident, "notes-api");
    for (const repo of ["shop", "shop-web", "control-plane", "jobs-runtime"]) {
      expect(closure.has(repo)).toBe(false);
    }
  });

  it("never stops a system ABOVE the seed", () => {
    // shop-web hard-depends on shop; `down shop` must not reach up to it.
    expect(startClosure(incident, "shop").has("shop-web")).toBe(false);
  });
});

describe("hardDepsOf", () => {
  it("returns only hard, non-event dependency targets", () => {
    expect(hardDepsOf(graph, "shop").sort()).toEqual(["links-api"]);
    expect(hardDepsOf(graph, "files-api").sort()).toEqual([
      "infra-stack",
      "links-api",
    ]);
    expect(hardDepsOf(graph, "notes-api")).toEqual([]); // only soft out-edges
  });
});

// ── filterClosureForStart ─────────────────────────────────────────────────────
//
// The auto-start toggle is a per-system preference, but it must not veto the
// system the engineer just clicked "up with deps" on. Shared by `den up
// <repo>` and the card action so the two cannot drift.

describe("filterClosureForStart", () => {
  it("skips auto-start-off systems pulled in as dependencies", () => {
    const res = filterClosureForStart(
      ["infra-stack", "tokens", "links-api"],
      "links-api",
      new Set(["tokens"]),
    );
    expect(res.start).toEqual(["infra-stack", "links-api"]);
    expect(res.skippedOff).toEqual(["tokens"]);
  });

  it("never skips the SEED, even when its auto-start is off", () => {
    const res = filterClosureForStart(
      ["infra-stack", "tokens"],
      "tokens",
      new Set(["tokens"]),
    );
    expect(res.start).toEqual(["infra-stack", "tokens"]);
    expect(res.skippedOff).toEqual([]);
  });

  it("preserves the derived order", () => {
    const order = ["a", "b", "c", "d"];
    expect(filterClosureForStart(order, "d", new Set()).start).toEqual(order);
  });

  it("returns everything when nothing is toggled off", () => {
    const res = filterClosureForStart(["a", "b"], "b", new Set());
    expect(res.start).toEqual(["a", "b"]);
    expect(res.skippedOff).toEqual([]);
  });
});

// ── startClosure ──────────────────────────────────────────────────────────────
//
// "up with deps" starts what a system sits ON TOP OF. The rule is POSITIONAL —
// strictly lower in the global start order — not kind-based, because tolerant
// edges point both ways: an event consumer can sit below (and must start) while
// a soft http call can point ten places up the stack (and must not).

describe("startClosure", () => {
  const g = (edges: Array<[string, string, string, string]>): DerivedGraph => ({
    nodes: [...new Set(edges.flatMap(([f, t]) => [f, t]))].sort(),
    edges: edges.map(([from, to, kind, blocking]) => ({
      from,
      to,
      kind,
      blocking,
      evidence: [],
    })) as DerivedGraph["edges"],
  });

  it("follows a tolerant EVENT dep that ranks below the seed", () => {
    // files-api --event--> notes-api: a kind-based rule drops this for
    // being an event edge, but orderForUp already ranks notes-api below.
    const graph = g([
      ["files-api", "links-api", "http", "hard"],
      ["files-api", "infra-stack", "infra", "hard"],
      ["files-api", "notes-api", "event", "soft"],
      ["links-api", "infra-stack", "infra", "hard"],
      ["notes-api", "infra-stack", "infra", "hard"],
    ]);
    const closure = startClosure(graph, "files-api");
    expect([...closure].sort()).toEqual([
      "files-api",
      "infra-stack",
      "links-api",
      "notes-api",
    ]);
  });

  it("refuses a tolerant dep that ranks ABOVE the seed", () => {
    // links-api --http(soft)--> shop-web, with shop-web at the top.
    const graph = g([
      ["links-api", "infra-stack", "infra", "hard"],
      ["links-api", "shop-web", "http", "soft"],
      ["shop-web", "links-api", "http", "hard"],
    ]);
    const closure = startClosure(graph, "links-api");
    expect(closure.has("shop-web")).toBe(false);
    expect([...closure].sort()).toEqual(["infra-stack", "links-api"]);
  });

  it("never follows a jwks edge, in either direction", () => {
    // The documented incident: notes→shop JWKS once booted shop's neighborhood.
    const graph = g([
      ["notes-api", "infra-stack", "infra", "hard"],
      ["notes-api", "shop", "jwks", "soft"],
      ["shop", "infra-stack", "infra", "hard"],
    ]);
    const closure = startClosure(graph, "notes-api");
    expect(closure.has("shop")).toBe(false);
  });

  it("keeps the seed alone when nothing sits below it", () => {
    const graph = g([["a", "b", "infra", "hard"]]);
    expect([...startClosure(graph, "b")]).toEqual(["b"]);
  });

  it("returns just the seed when it is not in the graph", () => {
    const graph = g([["a", "b", "infra", "hard"]]);
    expect([...startClosure(graph, "nope")]).toEqual(["nope"]);
  });

  it("orders the closure dependencies-first", () => {
    const graph = g([
      ["files-api", "links-api", "http", "hard"],
      ["files-api", "notes-api", "event", "soft"],
      ["links-api", "infra-stack", "infra", "hard"],
      ["notes-api", "infra-stack", "infra", "hard"],
    ]);
    const { order } = deriveStartTargets(graph, "files-api");
    expect(order[0]).toBe("infra-stack");
    expect(order[order.length - 1]).toBe("files-api");
    expect(order).toContain("notes-api");
  });
});

// ── down closure is the MIRROR, not the inverse ───────────────────────────────
//
// "down with dependents" must stop what BREAKS without the seed (above it),
// never what the seed itself runs on (below it) — those are still holding up
// everything else that is running.

describe("down with deps — symmetric with up with deps", () => {
  const graph: DerivedGraph = {
    nodes: ["links-api", "infra-stack", "files-api", "shop"],
    edges: [
      edge("links-api", "infra-stack", "infra", "hard"),
      edge("files-api", "links-api", "http", "hard"),
      edge("files-api", "infra-stack", "infra", "hard"),
      edge("shop", "files-api", "http", "hard"),
    ],
  };

  it("stops exactly what up with deps starts", () => {
    // The pairing only means anything if both operate on the same set; the
    // route reverses the order so the seed stops first and foundations last.
    const up = deriveStartTargets(graph, "files-api").order;
    expect([...up].sort()).toEqual(["files-api", "infra-stack", "links-api"]);
    const down = [...up].reverse();
    expect(down[0]).toBe("files-api");
    expect(down[down.length - 1]).toBe("infra-stack");
  });

  it("never reaches a system ABOVE the seed", () => {
    // shop depends on files-api; stopping files-api must not decide to
    // stop shop as well — the closure only ever walks downward.
    expect(startClosure(graph, "files-api").has("shop")).toBe(false);
  });
});
