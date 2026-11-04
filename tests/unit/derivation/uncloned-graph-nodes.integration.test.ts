/**
 * Regression: a managed repo that is CONFIGURED in the workspace but not
 * cloned yet (and has no sibling checkout to fall back to) must still be a graph
 * NODE. Out of the box den seeds a workspace whose repos are all
 * managed and none are cloned, so filtering nodes on disk-presence
 * rendered an empty graph and made `den up <repo>` a silent no-op.
 */

import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import * as fs from "fs";
import { sampleAliasesYaml } from "../fixtures/sample-topology.js";
import * as os from "os";
import * as path from "path";
import type { DerivedGraph } from "../../../src/shared/environment-manager/derivation/types.js";

let tmp: string;
let deriveGraph: (opts: {
  scope: "all" | "closure";
  seed?: string;
  refresh?: boolean;
  workspace?: string;
}) => DerivedGraph;
let orderForUp: (graph: DerivedGraph) => string[];

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "den-uncloned-"));
  const distRoot = path.join(tmp, "den");
  const repos = path.join(tmp, "repos");
  fs.mkdirSync(repos, { recursive: true });

  write(path.join(distRoot, "den.yml"), "product:\n  name: den\n");
  write(
    path.join(distRoot, "config", "den.yml"),
    ["repos_root: ../repos", "graph:", ...sampleAliasesYaml(), ""].join("\n"),
  );
  write(
    path.join(distRoot, "config", "local", "service-catalog.yml"),
    "files-api:\n  gh: x/files-api\ntokens:\n  gh: x/tokens\n",
  );
  write(
    path.join(distRoot, "config", "local", "workspaces.yml"),
    [
      "active: default",
      "workspaces:",
      "  default:",
      "    services:",
      "      files-api:", // managed AND cloned
      "        mode: managed",
      "        branch: main",
      "      tokens:", // managed, NOT cloned, no sibling either
      "        mode: managed",
      "        branch: main",
      "",
    ].join("\n"),
  );

  // Only files-api has a clone on disk. tokens has neither a managed clone
  // nor a sibling checkout — the true fresh-install shape.
  write(
    path.join(distRoot, ".den-services", "files-api", "main", ".den.yml"),
    "name: files-api\n",
  );
  write(
    path.join(distRoot, ".den-services", "files-api", "main", "Makefile"),
    "up:\n\t@echo u\n",
  );

  process.env.DEN_ROOT = distRoot;
  delete process.env.DEN_INVOKE_CWD;
  ({ deriveGraph } =
    await import("../../../src/shared/environment-manager/derivation/derive-graph.js"));
  ({ orderForUp } =
    await import("../../../src/shared/environment-manager/derivation/derived-up.js"));
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  delete process.env.DEN_ROOT;
});

describe("deriveGraph with un-cloned workspace repos", () => {
  it("keeps a configured-but-not-cloned managed repo as a node", () => {
    const g = deriveGraph({ scope: "all", refresh: true });
    expect(g.nodes).toContain("tokens");
    expect(g.nodes).toContain("files-api");
  });

  it("includes the un-cloned repo in the up order so it can be a seed", () => {
    const g = deriveGraph({ scope: "all", refresh: true });
    expect(orderForUp(g)).toContain("tokens");
  });

  it("does not invent nodes for repos absent from the workspace", () => {
    const g = deriveGraph({ scope: "all", refresh: true });
    expect(g.nodes).not.toContain("billing-api");
  });
});
