/**
 * ORG-1a: `register` (a managed clone picked from GitHub) lists the focused
 * workspace's org, with `--org <id>` to pick another. It never falls back to
 * Den's own checkout or remote (SEC-0): with no org it lists nothing.
 */
import { describe, expect, it } from "@jest/globals";
import type { DenConfig } from "../../../src/shared/den-config.js";
import type { OrgContext } from "../../../src/shared/environment-manager/workspace-org.js";
import {
  orgFlag,
  registerOrg,
  withoutOrgFlag,
} from "../../../src/ui/cli/org-command.js";

function ctx(config: Partial<DenConfig>, org?: string): OrgContext {
  return {
    config: { environments: ["local"], ...config } as DenConfig,
    catalog: { "globex-web": { gh: "globex/globex-web" } },
    file: {
      active: ["main", "client"],
      focus: "main",
      workspaces: {
        main: { services: {} },
        client: {
          services: { "globex-web": { mode: "managed" } },
          ...(org ? { org } : {}),
        },
      },
    },
    blueprints: [],
  };
}

describe("registerOrg", () => {
  it("is the workspace's resolved org", () => {
    const c = ctx({ github_org: "acme" });
    expect(registerOrg("main", undefined, c)).toBe("acme");
    expect(registerOrg("client", undefined, c)).toBe("globex");
    expect(registerOrg("client", undefined, ctx({}, "initech"))).toBe(
      "initech",
    );
  });

  it("--org wins", () => {
    expect(
      registerOrg("main", "example-org", ctx({ github_org: "acme" })),
    ).toBe("example-org");
  });

  it("with no org at all is undefined, never a guess", () => {
    expect(registerOrg("main", undefined, ctx({}))).toBeUndefined();
  });

  it("refuses a name gh could read as a flag or a path", () => {
    expect(registerOrg("main", "-x", ctx({}))).toBeUndefined();
    expect(registerOrg("main", "a/b", ctx({}))).toBeUndefined();
  });
});

describe("--org", () => {
  it("reads --org <id> and --org=<id>, and strips them", () => {
    expect(orgFlag(["list", "--org", "globex"])).toBe("globex");
    expect(orgFlag(["--org=acme"])).toBe("acme");
    expect(orgFlag(["list"])).toBeUndefined();
    expect(withoutOrgFlag(["a", "--org", "x", "b", "--org=y"])).toEqual([
      "a",
      "b",
    ]);
  });
});
