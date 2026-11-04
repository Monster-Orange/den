import { describe, expect, it } from "@jest/globals";
import { renderDot, renderText } from "../../../src/ui/cli/graph-command.js";
import {
  describeAppPlacement,
  describeRepoPlacement,
} from "../../../src/ui/cli/applications-command.js";
import type { DerivedGraph } from "../../../src/shared/environment-manager/derivation/types.js";

const graph: DerivedGraph = {
  nodes: ["shop-web", "shop-core", "shop-mixed"],
  edges: [
    {
      from: "shop-web",
      to: "shop-core",
      kind: "http",
      blocking: "soft",
      signal: "override:config",
      evidence: "config",
      confidence: "high",
    },
  ],
} as unknown as DerivedGraph;
const placements = new Map([
  ["shop-web", { placement: "local" as const, envs: [] }],
  ["shop-core", { placement: "remote" as const, envs: ["dev"] }],
  ["shop-mixed", { placement: "hybrid" as const, envs: ["dev"] }],
]);

describe("graph marks remote nodes", () => {
  it("text: a ☁ suffix on remote nodes, ⇄ on hybrid ones", () => {
    const out = renderText(graph, { placements, showEvidence: false });
    const line = (n: string) =>
      out.split("\n").find((l) => l.includes(n) && !l.includes("→"))!;
    expect(line("shop-core")).toMatch(/☁ remote \(dev\)/);
    expect(line("shop-mixed")).toMatch(/⇄ hybrid/);
    expect(line("shop-web")).not.toMatch(/remote|hybrid/);
  });

  it("dot: remote nodes are dashed", () => {
    const dot = renderDot(graph, placements);
    expect(dot).toContain(
      '"shop-core" [style=dashed, label="shop-core ☁ dev"];',
    );
    expect(dot).toContain('"shop-web";');
  });
});

describe("apps shows placement", () => {
  it("names a hybrid application's split", () => {
    expect(
      describeAppPlacement({
        placement: "hybrid",
        summary: "shop-frontend local · shop-core remote (dev)",
      }),
    ).toBe("⇄ hybrid: shop-frontend local · shop-core remote (dev)");
    expect(describeAppPlacement({ placement: "remote", summary: "x" })).toBe(
      "☁ remote",
    );
    expect(describeAppPlacement({ placement: "local", summary: "x" })).toBe("");
    expect(describeAppPlacement({ placement: "none", summary: "" })).toBe("");
  });

  it("suffixes a remote repo with where it runs", () => {
    expect(
      describeRepoPlacement([
        { runs: "remote", target: { env: "dev", account: "AWS" } },
      ]),
    ).toBe("☁ remote (dev)");
    expect(
      describeRepoPlacement([
        { runs: "local", target: null },
        { runs: "remote", target: { env: "dev" } },
      ]),
    ).toBe("⇄ hybrid");
    expect(describeRepoPlacement([{ runs: "local", target: null }])).toBe("");
  });
});
