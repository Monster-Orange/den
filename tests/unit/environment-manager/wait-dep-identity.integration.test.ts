/**
 * Pins the REAL identity function the wait-dep expansion is wired with —
 * `resolveService(addr, ws.name)` → `repoName/subsystem`.
 *
 * The expansion collapses addresses on this identity so one service named two
 * ways is not started twice (a duplicate down+up on `restart`). The algorithm
 * is unit-tested against stubs; this pins the resolution those stubs imitate,
 * over the three shapes that actually produce two spellings.
 */

import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

let tmp: string;
let resolveService: typeof import("../../../src/shared/environment-manager/service-runner.js").resolveService;

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

/** The identity the exec route passes as `identityOf`. */
function identityOf(addr: string, wsName: string): string {
  const r = resolveService(addr, wsName);
  return r ? `${r.repoName}/${r.subsystem}` : addr;
}

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "den-identity-"));
  const distRoot = path.join(tmp, "den");
  const repos = path.join(tmp, "repos");

  write(path.join(distRoot, "den.yml"), "product:\n  name: den\n");
  write(path.join(distRoot, "config", "den.yml"), "repos_root: ../repos\n");
  write(
    path.join(distRoot, "config", "local", "service-catalog.yml"),
    [
      "solo:",
      "  gh: x/solo",
      "selfnamed:",
      "  gh: x/selfnamed",
      "entry:",
      "  gh: x/entry",
      "",
    ].join("\n"),
  );
  write(
    path.join(distRoot, "config", "local", "workspaces.yml"),
    [
      "active: default",
      "workspaces:",
      "  default:",
      "    services:",
      "      solo:", // bare entry, single-service manifest
      "        mode: dev-managed",
      `        path: ${path.join(repos, "solo")}`,
      "      selfnamed:", // bare entry, manifest has a key equal to the repo name
      "        mode: dev-managed",
      `        path: ${path.join(repos, "selfnamed")}`,
      "      entry/api:", // registered ONLY by subsystem, manifest declares entrypoint
      "        mode: dev-managed",
      `        path: ${path.join(repos, "entry")}`,
      "      entry/db:",
      "        mode: dev-managed",
      `        path: ${path.join(repos, "entry")}`,
      "",
    ].join("\n"),
  );

  // Single-service repo whose ONE key differs from the repo name.
  write(
    path.join(repos, "solo", ".den.yml"),
    "name: solo\nservices:\n  svc:\n    commands:\n      local:\n        up: true\n",
  );
  // Manifest with a service key equal to the repo name, plus a sibling.
  write(
    path.join(repos, "selfnamed", ".den.yml"),
    "name: selfnamed\nservices:\n  selfnamed:\n    commands:\n      local:\n        up: true\n  api:\n    commands:\n      local:\n        up: true\n",
  );
  // Multi-service repo with a declared entrypoint.
  write(
    path.join(repos, "entry", ".den.yml"),
    "name: entry\nentrypoint: api\nservices:\n  api:\n    commands:\n      local:\n        up: true\n  db:\n    commands:\n      local:\n        up: true\n",
  );

  process.env.DEN_ROOT = distRoot;
  delete process.env.DEN_INVOKE_CWD;
  ({ resolveService } =
    await import("../../../src/shared/environment-manager/service-runner.js"));
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  delete process.env.DEN_ROOT;
});

describe("wait-dep identity (real resolveService wiring)", () => {
  it("maps a bare single-service repo onto its only service key", () => {
    // Listed as "solo"; a manifest dep could say "solo/svc". Same service.
    expect(identityOf("solo", "default")).toBe("solo/svc");
    expect(identityOf("solo/svc", "default")).toBe("solo/svc");
  });

  it("collapses repo/repo onto the bare address when the key equals the repo name", () => {
    // The `R/R` shape: listed as "selfnamed", dep written "selfnamed/selfnamed".
    expect(identityOf("selfnamed", "default")).toBe("selfnamed/selfnamed");
    expect(identityOf("selfnamed/selfnamed", "default")).toBe(
      "selfnamed/selfnamed",
    );
  });

  it("maps a bare multi-service repo onto its declared entrypoint", () => {
    // Registered only as entry/api + entry/db; a bare "entry" dep resolves to
    // the entrypoint, so it must collapse onto the listed entry/api.
    expect(identityOf("entry", "default")).toBe("entry/api");
    expect(identityOf("entry/api", "default")).toBe("entry/api");
  });

  it("keeps genuinely different services distinct", () => {
    expect(identityOf("entry/db", "default")).toBe("entry/db");
    expect(identityOf("entry/db", "default")).not.toBe(
      identityOf("entry/api", "default"),
    );
    expect(identityOf("selfnamed/api", "default")).toBe("selfnamed/api");
  });

  it("falls back to the raw address when nothing resolves", () => {
    expect(identityOf("not-in-workspace", "default")).toBe("not-in-workspace");
  });
});
