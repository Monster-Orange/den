import { describe, it, expect } from "@jest/globals";
import { buildAliasResolver } from "../../../src/shared/environment-manager/derivation/alias.js";
import { deriveComposeEdges } from "../../../src/shared/environment-manager/derivation/rules-compose.js";
import {
  composeCommands,
  composeHealthCmd,
  effectiveLocalCommands,
} from "../../../src/shared/stacks/manifest-commands.js";
import { shouldDetachServiceCommand } from "../../../src/shared/environment-manager/service-runner.js";
import type { RawManifest } from "../../../src/shared/types/index.js";

const repo = (content: string) => ({
  repoName: "demo-web",
  repoPath: "/x/demo-web",
  files: [{ rel: ".den.yml", abs: "/x/demo-web/.den.yml", content }],
});

describe("catalog repos are graph nodes", () => {
  it("adds registered repos to the known set, resolving to themselves", () => {
    const a = buildAliasResolver({ aliases: {} }, ["demo-api"]);
    expect(a.knownRepos.has("demo-api")).toBe(true);
    expect(a.resolve("demo-api")).toBe("demo-api");
  });

  it("keeps configured aliases for a registered repo", () => {
    const a = buildAliasResolver({ aliases: { "demo-web": ["storefront"] } }, [
      "demo-web",
    ]);
    expect(a.resolve("storefront")).toBe("demo-web");
  });
});

describe("compose.uses edges", () => {
  const alias = buildAliasResolver({ aliases: {} }, ["demo-api", "demo-web"]);

  it("turns each declared use into a hard http edge", () => {
    const edges = deriveComposeEdges(
      repo("name: demo-web\ncompose:\n  uses: [demo-api]\n"),
      alias,
    );
    expect(edges).toEqual([
      expect.objectContaining({
        from: "demo-web",
        to: "demo-api",
        kind: "http",
        blocking: "hard",
        signal: "compose:uses",
      }),
    ]);
  });

  it("ignores unknown names, self-references and broken YAML", () => {
    expect(
      deriveComposeEdges(repo("compose:\n  uses: [nope, demo-web]\n"), alias),
    ).toEqual([]);
    expect(deriveComposeEdges(repo("compose: [\n"), alias)).toEqual([]);
  });
});

describe("compose commands", () => {
  const m: RawManifest = {
    name: "demo-api",
    compose: { routes: { api: "api:8080" } },
    services: { "demo-api": {} },
  };

  it("synthesizes non-detachable stack commands for the primary service", () => {
    const c = composeCommands(m, "demo-api", "demo-api", "demo");
    expect(Object.keys(c).sort()).toEqual(["down", "logs", "restart", "up"]);
    expect(c.up).toEqual({
      cmd: expect.stringMatching(/bin\/den" stack up demo-api -w demo$/),
      detachable: false,
    });
    expect(composeHealthCmd(m, "demo-api", "demo-api", "demo")).toMatch(
      /stack health demo-api -w demo$/,
    );
  });

  it("uses compose.name as the stack name", () => {
    const c = composeCommands(
      { ...m, compose: { name: "api" } },
      "demo-api",
      "demo-api",
      "demo",
    );
    expect((c.down as { cmd: string }).cmd).toMatch(/stack down api -w demo$/);
  });

  it("lets declared commands win and skips non-primary services", () => {
    const declared: RawManifest = {
      ...m,
      services: {
        "demo-api": {
          commands: { local: { up: "make up", setup: "make setup" } },
        },
        worker: {},
      },
      entrypoint: "demo-api",
    };
    const eff = effectiveLocalCommands(
      declared,
      "demo-api",
      "demo-api",
      "demo",
    );
    expect(eff.up).toBe("make up");
    expect(eff.setup).toBe("make setup");
    expect(eff.down).toEqual(expect.objectContaining({ detachable: false }));
    // A non-entry service restarts on its own; up and down are the stack's.
    expect(composeCommands(declared, "worker", "demo-api", "demo")).toEqual({
      restart: {
        cmd: expect.stringMatching(
          /stack restart demo-api -w demo --service "worker"$/,
        ),
        detachable: false,
      },
    });
    // A non-entry service is a compose service with its own health check.
    expect(composeHealthCmd(declared, "worker", "demo-api", "demo")).toMatch(
      /stack health demo-api -w demo --service "worker"$/,
    );
  });

  it("gives nothing for a repo without a compose section", () => {
    expect(
      composeCommands({ name: "x", services: { x: {} } }, "x", "x", "demo"),
    ).toEqual({});
  });
});

describe("restart detaching", () => {
  it("detaches a plain restart but not one marked detachable: false", () => {
    expect(shouldDetachServiceCommand("restart", "make restart")).toBe(true);
    expect(
      shouldDetachServiceCommand("restart", { cmd: "x", detachable: false }),
    ).toBe(false);
    expect(shouldDetachServiceCommand("restart", { cmd: "x" })).toBe(true);
    expect(shouldDetachServiceCommand("down", "make down")).toBe(false);
  });
});
