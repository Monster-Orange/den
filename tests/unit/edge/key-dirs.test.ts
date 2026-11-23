/**
 * Issue 728: the folders that hold the edge's private keys (its CA's and its
 * own TLS key), from the resolved edge config, so an agent's deny rules
 * follow edge.state_dir, DEN_EDGE_DIR and a CA named by edge.tls.ca.
 */
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { edgeKeyDirs } from "../../../src/shared/edge/key-dirs.js";

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
  it("the default layout: the org's CA and the edge's certs under its state dir", () => {
    const edge = path.join(tmp, "xdg", "acme", "edge");
    expect(edgeKeyDirs(rootWith(TEAM))).toEqual([
      path.join(edge, "ca"),
      path.join(edge, "certs"),
    ]);
  });

  it("edge.state_dir moves both", () => {
    const st = path.join(tmp, "elsewhere");
    expect(edgeKeyDirs(rootWith(TEAM + `  state_dir: ${st}\n`))).toEqual([
      path.join(st, "ca"),
      path.join(st, "certs"),
    ]);
  });

  it("DEN_EDGE_DIR: the overriding dir, and the configured one too", () => {
    process.env.DEN_EDGE_DIR = path.join(tmp, "override");
    const edge = path.join(tmp, "xdg", "acme", "edge");
    expect(edgeKeyDirs(rootWith(TEAM))).toEqual([
      path.join(tmp, "override", "ca"),
      path.join(tmp, "override", "certs"),
      path.join(edge, "ca"),
      path.join(edge, "certs"),
    ]);
  });

  it("an existing CA named by tls.ca: that folder, not the org's own", () => {
    const ca = path.join(tmp, "shared-ca");
    const edge = path.join(tmp, "xdg", "acme", "edge");
    expect(
      edgeKeyDirs(rootWith(TEAM + `  tls: { strategy: mkcert, ca: ${ca} }\n`)),
    ).toEqual([ca, path.join(edge, "certs")]);
  });

  it("a broken edge config: the default key folders, for any org", () => {
    const share = path.join(tmp, "xdg");
    expect(edgeKeyDirs(rootWith(TEAM + "  aliases: not-a-list\n"))).toEqual([
      path.join(share, "*", "edge", "ca"),
      path.join(share, "*", "edge", "certs"),
    ]);
  });

  it("no edge configured: none, and no throw", () => {
    expect(edgeKeyDirs(rootWith("name: x\n"))).toEqual([]);
  });
});
