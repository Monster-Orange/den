/**
 * Issue 1391 (the bed's 573, Vision's ruling): on a test install the
 * fixture person may also validate a manifest by path, GET
 * /api/manifest/validate?path=… The route still reads only inside a
 * project's repos, and a fixture session exists only on a test install.
 */
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  fixturePersonPath,
  fixtureScopeRefusal,
  setupFixturePerson,
} from "../../../src/shared/fixture-person.js";
import { ensureWebSecret } from "../../../src/shared/web/web-secret.js";
import { validateAtPath } from "../../../src/ui/server/manifest-validate-path.js";

const GOOD =
  "name: shop\nservices:\n  web:\n    urls:\n      local: https://shop.example.com\n";

let tmp = "";
let repo = "";
let outside = "";
const deps = () => ({
  repoRoots: [repo],
  heldDir: path.join(tmp, "held"),
  home: path.join(tmp, "home"),
  stateDir: path.join(tmp, "home", ".den"),
});

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-fx573-")));
  for (const d of ["held", "home", "outside-secret-dir"])
    fs.mkdirSync(path.join(tmp, d), { recursive: true });
  process.env.DEN_MANIFESTS_DIR = path.join(tmp, "held");
  repo = path.join(tmp, "shop");
  fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".den.yml"), GOOD);
  outside = path.join(tmp, "outside-secret-dir");
  fs.writeFileSync(path.join(outside, "elsewhere.yml"), GOOD);
});

afterEach(() => {
  delete process.env.DEN_MANIFESTS_DIR;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("the fixture person validates a manifest by path (issue 1391, the bed's 573)", () => {
  it("1. on a test install, a path inside the repos: allowed, and validated", () => {
    expect(
      fixtureScopeRefusal("GET", "/api/manifest/validate", "mutating"),
    ).toBeNull();
    const r = validateAtPath(repo, deps());
    expect(r.status).toBe(200);
    expect((r.body as { valid?: boolean }).valid).toBe(true);
  });

  it("only that path: nothing near it opens", () => {
    for (const p of [
      "/api/manifest/validate/x",
      "/api/manifest/validatex",
      "/api/manifest",
    ])
      expect(fixtureScopeRefusal("GET", p, "mutating")).toMatch(
        /fixture person/,
      );
    expect(
      fixtureScopeRefusal("DELETE", "/api/manifest/validate", "mutating"),
    ).toMatch(/fixture person/);
  });

  it("2. a path outside the repos: still refused by the route, quoting nothing", () => {
    const p = path.join(outside, "elsewhere.yml");
    const r = validateAtPath(p, deps());
    expect(r.status).toBe(403);
    expect((r.body as { code?: string }).code).toBe("outside_repos");
    const said = JSON.stringify(r.body);
    expect(said).not.toContain("outside-secret-dir");
    expect(said).not.toContain("elsewhere");
    expect(said).not.toContain("shop.example.com");
  });

  it("3. a non-test install: no fixture session (not_test_install)", () => {
    const r = setupFixturePerson(tmp, {
      testInstall: false,
      agent: false,
      webSecret: ensureWebSecret(tmp),
    });
    expect(r.ok ? "" : r.code).toBe("not_test_install");
    expect(fs.existsSync(fixturePersonPath(tmp))).toBe(false);
  });
});
