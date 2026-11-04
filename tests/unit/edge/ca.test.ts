import { describe, it, expect } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  assertCaUsable,
  caDir,
  includeFiles,
  sharedCa,
  syncIncluded,
} from "../../../src/shared/edge/runtime.js";
import type { EdgeConfig } from "../../../src/shared/edge/types.js";

const base: EdgeConfig = {
  org: "acme",
  domain: "acme.localhost",
  aliases: [],
  image: "traefik:v2.11",
  workspaces: [],
  routes: {},
  ports: null,
  stateDir: "/tmp/acme-edge",
  caroot: null,
  issueCert: true,
  httpsRedirect: true,
  dockerLabels: null,
  include: null,
  mounts: {},
  networks: [],
  args: [],
};

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "edge-ca-"));
}

describe("org CA", () => {
  it("defaults to a CA of the org's own under the state dir", () => {
    expect(caDir(base)).toBe("/tmp/acme-edge/ca");
    expect(sharedCa(base)).toBe(false);
  });

  it("uses an existing CA when caroot is set", () => {
    const ca = tmp();
    fs.writeFileSync(path.join(ca, "rootCA.pem"), "x");
    fs.writeFileSync(path.join(ca, "rootCA-key.pem"), "x");
    const cfg = { ...base, caroot: ca };
    expect(caDir(cfg)).toBe(ca);
    expect(sharedCa(cfg)).toBe(true);
    expect(() => assertCaUsable(cfg)).not.toThrow();
  });

  it("refuses to run when the shared CA's key is missing, so mkcert never mints a new CA", () => {
    const ca = tmp();
    fs.writeFileSync(path.join(ca, "rootCA.pem"), "x");
    expect(() => assertCaUsable({ ...base, caroot: ca })).toThrow(
      /rootCA-key\.pem/,
    );
    expect(() =>
      assertCaUsable({ ...base, caroot: path.join(ca, "missing") }),
    ).toThrow(/never creates/);
  });

  it("lets an own CA be created on first use", () => {
    expect(() => assertCaUsable(base)).not.toThrow();
  });
});

describe("include", () => {
  it("lists the YAML files to copy into the dynamic directory, sorted", () => {
    const dir = tmp();
    for (const f of ["tls.yml", "a.yaml", "README.md", "edge.yml"])
      fs.writeFileSync(path.join(dir, f), "");
    fs.mkdirSync(path.join(dir, "certs"));
    expect(includeFiles(dir)).toEqual(["a.yaml", "tls.yml"]);
  });
  it("is empty when nothing is included", () => {
    expect(includeFiles(null)).toEqual([]);
  });
});

describe("syncIncluded", () => {
  const dynOf = (state: string) => path.join(state, "dynamic");
  const names = (dir: string) => fs.readdirSync(dir).sort();
  function stateWithRoutes(): string {
    const state = tmp();
    fs.mkdirSync(dynOf(state), { recursive: true });
    for (const f of ["edge.yml", "stack-shop-main.yml", "stack-web-main.yml"])
      fs.writeFileSync(path.join(dynOf(state), f), "routes");
    return state;
  }

  it("never removes running stacks' route files when include is unset", () => {
    const state = stateWithRoutes();
    expect(syncIncluded({ ...base, stateDir: state, include: null })).toEqual(
      [],
    );
    expect(names(dynOf(state))).toEqual([
      "edge.yml",
      "stack-shop-main.yml",
      "stack-web-main.yml",
    ]);
  });

  it("prunes only files a previous sync copied in", () => {
    const state = stateWithRoutes();
    const inc = tmp();
    fs.writeFileSync(path.join(inc, "tls.yml"), "tls");
    fs.writeFileSync(path.join(inc, "redirect.yml"), "r");
    syncIncluded({ ...base, stateDir: state, include: inc });
    expect(fs.existsSync(path.join(dynOf(state), "redirect.yml"))).toBe(true);

    fs.rmSync(path.join(inc, "redirect.yml"));
    syncIncluded({ ...base, stateDir: state, include: inc });
    const left = names(dynOf(state));
    expect(left).toEqual([
      "edge.yml",
      "stack-shop-main.yml",
      "stack-web-main.yml",
      "tls.yml",
    ]);

    // Dropping include entirely removes the copies, still never the stacks'.
    syncIncluded({ ...base, stateDir: state, include: null });
    expect(names(dynOf(state))).toEqual([
      "edge.yml",
      "stack-shop-main.yml",
      "stack-web-main.yml",
    ]);
  });

  it("never copies or prunes an included file named like a stack route", () => {
    const state = stateWithRoutes();
    const inc = tmp();
    fs.writeFileSync(path.join(inc, "stack-shop-main.yml"), "included");
    syncIncluded({ ...base, stateDir: state, include: inc });
    expect(
      fs.readFileSync(path.join(dynOf(state), "stack-shop-main.yml"), "utf-8"),
    ).toBe("routes");
  });
});
