import { describe, it, expect, afterAll } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { resolveApplications } from "../../src/shared/applications.js";
import { describeContributor } from "../../src/ui/cli/applications-command.js";
import {
  contributesTo,
  hasRuntime,
  noRuntimeReason,
  repoHasRuntime,
  repoKind,
  runsNothing,
} from "../../src/shared/repo-kind.js";
import { v1ManifestSchema as ManifestSchema } from "../../src/shared/manifest/schema.js";
import type { DerivedEdge } from "../../src/shared/environment-manager/derivation/types.js";

const dirs: string[] = [];
function repoWith(manifest?: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "den-kind-"));
  dirs.push(d);
  if (manifest) fs.writeFileSync(path.join(d, ".den.yml"), manifest);
  return d;
}
afterAll(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

const sdk = (from: string, to: string): DerivedEdge => ({
  from,
  to,
  kind: "http",
  blocking: "hard",
  signal: "http:sdk-import",
  evidence: "",
  confidence: "high",
});

describe("repo kind", () => {
  it("defaults to service, and only services have a runtime", () => {
    expect(repoKind(repoWith())).toBe("service");
    expect(repoKind(repoWith("name: x\nservices: {x: {}}\n"))).toBe("service");
    expect(hasRuntime("service")).toBe(true);
    expect(hasRuntime("module")).toBe(false);
    expect(hasRuntime("library")).toBe(false);
  });

  it("reads kind and merges declared contributes_to with SDK importers", () => {
    const p = repoWith(
      "name: feat\nkind: module\ncontributes_to: [core]\nservices: {feat: {}}\n",
    );
    expect(repoKind(p)).toBe("module");
    const graph = {
      nodes: [],
      edges: [sdk("core", "feat"), sdk("web", "feat"), sdk("feat", "other")],
    };
    expect(contributesTo("feat", p, graph)).toEqual(["core", "web"]);
  });

  it("rejects an unknown kind in a manifest", () => {
    expect(
      ManifestSchema.safeParse({ name: "x", kind: "daemon", services: {} })
        .success,
    ).toBe(false);
  });
});

describe("issue 277: a repo that runs nothing has no runtime", () => {
  it("no services and no compose stack: runs nothing; services: [] is the same", () => {
    for (const m of [
      "name: cfg\nservices: {}\n",
      "name: cfg\nservices: []\n",
      "name: cfg\n",
    ]) {
      const p = repoWith(m);
      expect(repoHasRuntime(p)).toBe(false);
      expect(noRuntimeReason(p)).toBe("runs nothing");
    }
  });

  it("a service, a compose stack, or no manifest yet (Den can't tell) keeps its runtime", () => {
    for (const p of [
      repoWith("name: x\nservices: {x: {}}\n"),
      repoWith("name: x\ncompose: {files: [compose.yaml]}\n"),
      repoWith(),
    ]) {
      expect(repoHasRuntime(p)).toBe(true);
      expect(noRuntimeReason(p)).toBeNull();
    }
    expect(runsNothing(null)).toBe(false);
  });

  it("a module or library says its kind, as before", () => {
    const p = repoWith("name: feat\nkind: library\nservices: {}\n");
    expect(repoHasRuntime(p)).toBe(false);
    expect(noRuntimeReason(p)).toBe("library");
  });
});

describe("applications with modules", () => {
  it("lists modules and libraries as contributors, not as runtime repos", () => {
    const [north] = resolveApplications({
      repos: ["core", "feat", "lib"],
      config: { north: { repos: ["core", "feat", "lib"] } },
      kinds: { feat: "module", lib: "library" },
      contributesTo: { feat: ["core"] },
    });
    expect(north.repos).toEqual(["core"]);
    expect(north.contributors).toEqual([
      { repo: "feat", kind: "module", contributesTo: ["core"] },
      { repo: "lib", kind: "library", contributesTo: [] },
    ]);
    expect(describeContributor(north.contributors[0])).toBe(
      "feat (module) → ships in core",
    );
  });
});
