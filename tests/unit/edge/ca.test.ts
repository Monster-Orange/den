import { describe, it, expect } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  assertCaUsable,
  caDir,
  includeFiles,
  sharedCa,
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
