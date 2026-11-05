/**
 * ORG-1a: seeding gives a blueprint repo with no `gh` its workspace's org,
 * not `github_org`, so a client workspace never clones from the default org
 * on a fresh machine. A workspace with no org of its own still gets
 * `github_org` (an old config seeds exactly as before), and a repo the
 * catalog already has keeps its slug. Real fs in a temp DEN_ROOT.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

let tmp: string;
let mod: typeof import("../../../src/shared/environment-manager/default-workspace.js");
let readCatalog: typeof import("../../../src/shared/environment-manager/catalog.js").readCatalog;

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "den-defws-org-"));
  fs.mkdirSync(path.join(tmp, "config", "local"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "den.yml"), "product:\n  name: den\n");
  fs.writeFileSync(
    path.join(tmp, "config", "den.yml"),
    [
      "github_org: acme",
      "orgs:",
      "  globex: { label: Globex }",
      "defaults:",
      "  workspaces:",
      "    main:",
      "      repos: [acme-api, shared-lib]",
      "      focus: true",
      "    client:",
      "      org: globex",
      "      repos: [globex-web, globex-api, kept]",
      "",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(tmp, "config", "local", "service-catalog.yml"),
    "kept:\n  gh: initech/kept\n",
  );
  process.env.DEN_ROOT = tmp;
  delete process.env.DEN_WORKSPACE_OVERRIDE;
  mod =
    await import("../../../src/shared/environment-manager/default-workspace.js");
  ({ readCatalog } =
    await import("../../../src/shared/environment-manager/catalog.js"));
});

afterAll(() => {
  delete process.env.DEN_ROOT;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("seeding stamps each workspace's org", () => {
  it("plans the slugs without writing the catalog", () => {
    const before = fs.readFileSync(
      path.join(tmp, "config", "local", "service-catalog.yml"),
      "utf-8",
    );
    const fill = mod.catalogFill(mod.blueprintWorkspaces());
    expect(Object.fromEntries(fill)).toEqual({
      "acme-api": "acme/acme-api",
      "shared-lib": "acme/shared-lib",
      "globex-web": "globex/globex-web",
      "globex-api": "globex/globex-api",
    });
    expect(
      fs.readFileSync(
        path.join(tmp, "config", "local", "service-catalog.yml"),
        "utf-8",
      ),
    ).toBe(before);
  });

  it("writes the client workspace's repos under its own org", () => {
    mod.seedBlueprintWorkspaces();
    expect(readCatalog()).toEqual({
      kept: { gh: "initech/kept" },
      "acme-api": { gh: "acme/acme-api" },
      "shared-lib": { gh: "acme/shared-lib" },
      "globex-web": { gh: "globex/globex-web" },
      "globex-api": { gh: "globex/globex-api" },
    });
  });

  it("never writes the resolved org into workspaces.yml", () => {
    const ws = fs.readFileSync(
      path.join(tmp, "config", "local", "workspaces.yml"),
      "utf-8",
    );
    expect(ws).not.toMatch(/\borg:/);
  });
});
