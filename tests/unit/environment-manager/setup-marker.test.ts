/**
 * Setup success-marker helpers: den records a marker once `make setup` has
 * succeeded for a managed clone, so `den up` can tell a fully-prepared clone
 * from one that was cloned but never (verifiably) set up — and re-run setup
 * instead of starting a half-prepared repo. Uses real fs in a temp dir.
 */

import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  setupMarkerPath,
  hasSetupSucceeded,
  markSetupSucceeded,
  hasSetupCommand,
} from "../../../src/shared/environment-manager/workspace-manager.js";

let tmp: string;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "den-setup-marker-"));
});
afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("setup success marker", () => {
  it("places the marker beside the clone dir, not inside the repo", () => {
    const clone = path.join(tmp, "repo", "main");
    expect(setupMarkerPath(clone)).toBe(
      path.join(tmp, "repo", ".main.setup-ok"),
    );
  });

  it("hasSetupSucceeded flips from false to true after markSetupSucceeded", () => {
    const clone = path.join(tmp, "repo", "main");
    fs.mkdirSync(clone, { recursive: true });
    expect(hasSetupSucceeded(clone)).toBe(false);
    markSetupSucceeded(clone);
    expect(hasSetupSucceeded(clone)).toBe(true);
    // The marker must live outside the clone dir (no dirty working-tree file).
    expect(fs.existsSync(path.join(clone, ".main.setup-ok"))).toBe(false);
  });

  it("hasSetupCommand is true with a Makefile and false for a bare dir", () => {
    const withMake = path.join(tmp, "withmake");
    fs.mkdirSync(withMake, { recursive: true });
    fs.writeFileSync(path.join(withMake, "Makefile"), "setup:\n\t@echo s\n");
    expect(hasSetupCommand(withMake)).toBe(true);

    const bare = path.join(tmp, "bare");
    fs.mkdirSync(bare, { recursive: true });
    expect(hasSetupCommand(bare)).toBe(false);
  });
});
