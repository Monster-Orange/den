/**
 * Issue 728: the folders that hold the edge's secrets (its CA's key, its TLS
 * key, its proof and stack secrets), from the resolved edge config, so an agent's deny rules
 * follow edge.state_dir, DEN_EDGE_DIR and a CA named by edge.tls.ca.
 */
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  edgeKeyDirs,
  narrowEdgeDirs,
} from "../../../src/shared/edge/key-dirs.js";

const TEAM = "edge:\n  org: acme\n  domain: acme.localhost\n";

let tmp: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "edge-keys-")));
  for (const k of ["DEN_EDGE_DIR", "XDG_DATA_HOME"]) saved[k] = process.env[k];
  delete process.env.DEN_EDGE_DIR;
  process.env.XDG_DATA_HOME = path.join(tmp, "xdg");
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved))
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  fs.rmSync(tmp, { recursive: true, force: true });
});

function rootWith(team: string, user?: string): string {
  const root = path.join(tmp, `root-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(path.join(root, "config", "local"), { recursive: true });
  fs.writeFileSync(path.join(root, "config", "den.yml"), team);
  if (user)
    fs.writeFileSync(path.join(root, "config", "local", "user.yml"), user);
  return root;
}

describe("issue 728: the edge's key folders", () => {
  it("the default layout: the whole edge state folder (its CA, certs, proof and stack secrets)", () => {
    expect(edgeKeyDirs(rootWith(TEAM))).toEqual([
      path.join(tmp, "xdg", "acme", "edge"),
    ]);
  });

  it("edge.state_dir moves it", () => {
    const st = path.join(tmp, "elsewhere");
    expect(edgeKeyDirs(rootWith(TEAM + `  state_dir: ${st}\n`))).toEqual([st]);
  });

  it("DEN_EDGE_DIR: the overriding folder, and the configured one too", () => {
    process.env.DEN_EDGE_DIR = path.join(tmp, "override");
    expect(edgeKeyDirs(rootWith(TEAM))).toEqual([
      path.join(tmp, "override"),
      path.join(tmp, "xdg", "acme", "edge"),
    ]);
  });

  it("an existing CA named by tls.ca: that folder too", () => {
    const ca = path.join(tmp, "shared-ca");
    expect(
      edgeKeyDirs(rootWith(TEAM + `  tls: { strategy: mkcert, ca: ${ca} }\n`)),
    ).toEqual([path.join(tmp, "xdg", "acme", "edge"), ca]);
  });

  it("a broken edge config: every org's default edge folder", () => {
    expect(edgeKeyDirs(rootWith(TEAM + "  aliases: not-a-list\n"))).toEqual([
      path.join(tmp, "xdg", "*", "edge"),
    ]);
  });

  it("no edge configured: none, and no throw", () => {
    expect(edgeKeyDirs(rootWith("name: x\n"))).toEqual([]);
  });

  it("an edge folder that holds this install's own folders is narrowed to its secret parts", () => {
    const edge = "/home/someone/.acme";
    const own = ["/home/someone/.acme", "/home/someone/projects/den"];
    expect(narrowEdgeDirs([edge, "/srv/ca"], own)).toEqual([
      "/home/someone/.acme/ca",
      "/home/someone/.acme/certs",
      "/home/someone/.acme/dynamic",
      "/home/someone/.acme/stacks",
      "/home/someone/.acme/den-edge-proof",
      "/home/someone/.acme/access",
      "/home/someone/.acme/edge-access.log",
      "/home/someone/.acme/proof-rotated.json",
      "/srv/ca",
    ]);
    expect(narrowEdgeDirs(["/home/someone"], own)[0]).toBe("/home/someone/ca");
    expect(narrowEdgeDirs(["/srv/edge"], own)).toEqual(["/srv/edge"]);
  });
});
