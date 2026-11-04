/**
 * End-to-end test for `buildUpPlan` over a fixture workspace.
 *
 * `buildUpPlan` resolves each ordered repo through the active workspace
 * (`resolveService`), so this sets DEN_ROOT to a temp den dir with a
 * service-catalog + workspaces file and dev-managed repos on disk, then asserts
 * the per-node plan: command/source resolution, optional/interactive/no-command
 * flags, the den.yml override note, default action, and the unresolvable-repo
 * fallback. Imports are dynamic so the modules capture the temp DEN_ROOT.
 */

import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { DerivedGraph } from "../../../src/shared/environment-manager/derivation/types.js";
import type { NodePlan } from "../../../src/shared/environment-manager/up-plan.js";

let tmp: string;
let buildUpPlan: (
  graph: DerivedGraph,
  order: string[],
  opts?: { noAutostart?: Set<string> },
) => NodePlan[];

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "den-upplan-build-"));
  const distRoot = path.join(tmp, "den");
  const repos = path.join(tmp, "repos");

  // clean: headless `make up`; opt: identical, but auto-start off via opts.
  for (const r of ["clean", "opt"]) {
    write(
      path.join(repos, r, "Makefile"),
      ["up:", "\t@opctl run dev", ""].join("\n"),
    );
  }
  // billing: `up` aliases `dev`, whose recipe runs an unguarded osascript → interactive (tabs).
  write(
    path.join(repos, "billing", "Makefile"),
    [
      "up: dev",
      "",
      "dev:",
      "\t@osascript -e 'tell application \"iTerm2\" to create tab'",
      "\topctl run dev",
      "",
    ].join("\n"),
  );
  // nocmd: no `up` target, no op, no manifest up command → no resolvable command.
  write(
    path.join(repos, "nocmd", "Makefile"),
    ["setup:", "\t@echo s", ""].join("\n"),
  );
  // withoverride: has `make up` AND a differing `.den.yml up:` → surfaces an override note.
  write(
    path.join(repos, "withoverride", "Makefile"),
    ["up:", "\t@opctl run dev", ""].join("\n"),
  );
  write(
    path.join(repos, "withoverride", ".den.yml"),
    [
      "services:",
      "  withoverride:",
      "    commands:",
      "      local:",
      "        up: custom-up-cmd",
      "",
    ].join("\n"),
  );

  // remote: has `make up`, but its manifest places it in dev (R13).
  write(
    path.join(repos, "remote", "Makefile"),
    ["up:", "\t@opctl run dev", ""].join("\n"),
  );
  write(
    path.join(repos, "remote", ".den.yml"),
    [
      "name: remote",
      "services:",
      "  remote:",
      "    runs: { local: remote }",
      "    target: { env: dev, account: AWS }",
      "",
    ].join("\n"),
  );

  const catalog: Record<string, { gh: string }> = {};
  const services: Record<string, { mode: string; path: string }> = {};
  for (const r of [
    "clean",
    "opt",
    "billing",
    "nocmd",
    "withoverride",
    "remote",
  ]) {
    catalog[r] = { gh: `Org/${r}` };
    services[r] = { mode: "dev-managed", path: path.join(repos, r) };
  }
  write(
    path.join(distRoot, "config", "local", "service-catalog.yml"),
    JSON.stringify(catalog),
  );
  write(
    path.join(distRoot, "config", "local", "workspaces.yml"),
    JSON.stringify({
      active: ["test"],
      focus: "test",
      workspaces: { test: { services } },
    }),
  );
  // getDistRoot() validates that DEN_ROOT points at a den checkout.
  write(path.join(distRoot, "den.yml"), "product:\n  name: den\n");

  process.env.DEN_ROOT = distRoot;
  delete process.env.DEN_WORKSPACE_OVERRIDE;
  ({ buildUpPlan } =
    await import("../../../src/shared/environment-manager/up-plan.js"));
});

afterAll(() => {
  delete process.env.DEN_ROOT;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("buildUpPlan", () => {
  it("builds a per-node plan with command, flags, and default action", () => {
    const graph = { nodes: [], edges: [] } as unknown as DerivedGraph;
    const order = ["clean", "opt", "billing", "nocmd", "withoverride", "ghost"];
    const plans = buildUpPlan(graph, order, { noAutostart: new Set(["opt"]) });
    const by = Object.fromEntries(plans.map((p) => [p.repo, p]));

    // Headless make up → start by default.
    expect(by.clean).toMatchObject({
      upCommand: "make up",
      upSource: "make",
      noAutostart: false,
      interactive: false,
      defaultAction: "start",
    });
    expect(by.clean.flags).toEqual([]);

    // Optional prior → flagged + skipped.
    expect(by.opt).toMatchObject({ noAutostart: true, defaultAction: "skip" });
    expect(by.opt.flags).toContain("auto-start off");

    // Unguarded osascript → interactive (tabs) → skipped.
    expect(by.billing).toMatchObject({
      interactive: true,
      interactiveKind: "tabs",
      defaultAction: "skip",
    });
    expect(by.billing.flags).toContain("interactive");

    // No up target anywhere → no command → skipped.
    expect(by.nocmd).toMatchObject({
      upCommand: null,
      upSource: "none",
      defaultAction: "skip",
    });
    expect(by.nocmd.flags).toContain("no-command");

    // make up wins, but the differing manifest up is surfaced as a note.
    expect(by.withoverride.upCommand).toBe("make up");
    expect(by.withoverride.notes.join(" ")).toMatch(/override available/i);

    // Unregistered repo → unresolvable fallback plan.
    expect(by.ghost).toMatchObject({
      upCommand: null,
      upSource: "none",
      defaultAction: "skip",
    });
    expect(by.ghost.notes.join(" ")).toMatch(/not resolvable/i);
  });

  it("defaults the no-autostart set to empty when none is provided", () => {
    const graph = { nodes: [], edges: [] } as unknown as DerivedGraph;
    const plans = buildUpPlan(graph, ["clean"]);
    expect(plans[0].noAutostart).toBe(false);
    expect(plans[0].flags).not.toContain("auto-start off");
  });

  it("never starts a remote service, even with a make up", () => {
    const graph = { nodes: [], edges: [] } as unknown as DerivedGraph;
    const [plan] = buildUpPlan(graph, ["remote"]);
    expect(plan).toMatchObject({
      upCommand: null,
      upSource: "none",
      defaultAction: "skip",
    });
    expect(plan.flags).toContain("remote");
    expect(plan.notes.join(" ")).toMatch(
      /runs in dev \(AWS\); nothing to start/,
    );
  });
});
