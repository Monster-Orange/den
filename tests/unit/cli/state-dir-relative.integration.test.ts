/**
 * A relative `product.state_dir` in den.yml is relative to the directory
 * that holds den.yml (the distribution root), never the cwd: an agent's CLI
 * or MCP server started in its workspace's directory reads the same state
 * as the person's CLI in the root.
 *
 * Real bin/den in a throwaway distribution (product north, state_dir
 * ./state), run from another directory. `web token --print` makes
 * web.secret in the state dir; the token itself is never printed (a
 * failure shows booleans).
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { readProfileFile } from "../../../src/shared/profile.js";

const ENGINE = path.resolve(__dirname, "../../..");
let tmp = "";
let root = "";
let elsewhere = "";

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

beforeAll(() => {
  tmp = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "den-statedir-")),
  );
  root = path.join(tmp, "dist");
  elsewhere = path.join(tmp, "workspaces", "south");
  write(
    path.join(root, "den.yml"),
    "product:\n  name: north\n  state_dir: ./state\n",
  );
  write(path.join(root, "config", "north.yml"), "environments: [local]\n");
  fs.mkdirSync(elsewhere, { recursive: true });
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("a relative product.state_dir", () => {
  it("resolves against den.yml's directory, whatever the cwd (readProfileFile)", () => {
    const before = process.cwd();
    try {
      process.chdir(elsewhere);
      expect(readProfileFile(path.join(root, "den.yml")).stateDir).toBe(
        path.join(root, "state"),
      );
    } finally {
      process.chdir(before);
    }
  });

  it("the CLI run from another directory writes the distribution's state, not the cwd's", () => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      DEN_ROOT: root,
      HOME: path.join(tmp, "home"),
      FORCE_COLOR: "0",
      NO_COLOR: "1",
    };
    // Nothing may override the profile's state_dir here.
    delete env.NORTH_HOME;
    delete env.DEN_PROFILE;
    const r = spawnSync(
      path.join(ENGINE, "bin", "den"),
      ["web", "token", "--print"],
      { cwd: elsewhere, encoding: "utf-8", input: "", env, timeout: 60_000 },
    );
    expect(r.status).toBe(0);
    expect(fs.existsSync(path.join(root, "state", "web.secret"))).toBe(true);
    expect(fs.existsSync(path.join(elsewhere, "state"))).toBe(false);
  }, 60_000);
});
