/**
 * `repo add`'s detection (ON-2): how a repo runs, read from its Makefile,
 * compose file and package.json. A Makefile `up` decides; otherwise exactly
 * one other candidate decides, and anything else is a question with its
 * choices. The side-car it builds passes the manifest validator.
 */
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  detectRunCommands,
  needsDocker,
  repoNameFrom,
  sidecarManifest,
} from "../../../src/ui/cli/repo-detect.js";
import { validateManifest } from "../../../src/shared/manifest/validate-manifest.js";

let dir = "";
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-detect-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const put = (rel: string, text: string) =>
  fs.writeFileSync(path.join(dir, rel), text);
const pkg = (scripts: Record<string, string>) =>
  put("package.json", JSON.stringify({ name: "x", scripts }));

describe("detectRunCommands", () => {
  it("a Makefile up target decides, with down/setup/restart/test when present", () => {
    put("Makefile", "up:\n\t@x\ndown:\n\t@x\nsetup:\n\t@x\ntest:\n\t@x\n");
    pkg({ dev: "vite" }); // the Makefile wins over package scripts
    expect(detectRunCommands(dir)).toEqual({
      decided: true,
      commands: {
        source: "make",
        up: "make up",
        down: "make down",
        setup: "make setup",
        test: "make test",
      },
    });
  });

  it("one compose file decides: docker compose up -d / down", () => {
    put("compose.yaml", "services: {}\n");
    const d = detectRunCommands(dir);
    expect(d).toEqual({
      decided: true,
      commands: {
        source: "compose",
        up: "docker compose -f compose.yaml up -d",
        down: "docker compose -f compose.yaml down",
        composeFile: "compose.yaml",
      },
    });
  });

  it("package.json: dev over start, and test as the suite", () => {
    pkg({ dev: "next dev", start: "next start", test: "jest" });
    expect(detectRunCommands(dir)).toEqual({
      decided: true,
      commands: { source: "package.json", up: "npm run dev", test: "npm test" },
    });
    pkg({ start: "node ." });
    expect(detectRunCommands(dir)).toMatchObject({
      decided: true,
      commands: { up: "npm start" },
    });
  });

  it("npm's placeholder test script is not a suite", () => {
    pkg({ start: "node .", test: 'echo "Error: no test specified" && exit 1' });
    const d = detectRunCommands(dir);
    expect(d.decided && d.commands.test).toBeFalsy();
  });

  it("two candidates: a question with both as choices", () => {
    put("docker-compose.yml", "services: {}\n");
    pkg({ dev: "vite" });
    expect(detectRunCommands(dir)).toEqual({
      decided: false,
      ask: expect.stringMatching(/2 ways/),
      choices: ["docker compose -f docker-compose.yml up -d", "npm run dev"],
    });
  });

  it("nothing to go on: a question with no choices", () => {
    put("Makefile", "build:\n\t@x\n"); // a Makefile without up decides nothing
    expect(detectRunCommands(dir)).toEqual({
      decided: false,
      ask: expect.stringMatching(/How do you usually start this repo/),
      choices: [],
    });
  });

  it("--run decides, keeping a Makefile down and the test suite", () => {
    put("Makefile", "down:\n\t@x\n");
    pkg({ test: "vitest" });
    expect(detectRunCommands(dir, { run: "./serve.sh" })).toEqual({
      decided: true,
      commands: {
        source: "--run",
        up: "./serve.sh",
        down: "make down",
        test: "npm test",
      },
    });
  });
});

describe("sidecarManifest", () => {
  it("is a valid manifest, health included when given", () => {
    const m = sidecarManifest(
      "shop",
      { source: "make", up: "make up", down: "make down", test: "make test" },
      "http://localhost:4100/",
    );
    expect(m).toEqual({
      version: 1,
      name: "shop",
      services: {
        shop: {
          commands: { local: { up: "make up", down: "make down" } },
          health: { local: { url: "http://localhost:4100/" } },
        },
      },
      tests: { unit: { cmd: "make test" } },
    });
    expect(validateManifest(m, { environments: ["local"] }).valid).toBe(true);
  });
});

describe("needsDocker", () => {
  it("a compose block, a docker command, or a compose file", () => {
    expect(needsDocker({ compose: { files: ["c.yml"] } })).toBe(true);
    expect(
      needsDocker({
        services: {
          a: { commands: { local: { up: "docker compose up -d" } } },
        },
      }),
    ).toBe(true);
    expect(
      needsDocker({
        services: {
          a: { commands: { local: { up: { cmd: "docker run x" } } } },
        },
      }),
    ).toBe(true);
    expect(
      needsDocker({
        services: { a: { commands: { local: { up: "make up" } } } },
      }),
    ).toBe(false);
    expect(needsDocker(null, dir)).toBe(false);
    put("compose.yml", "services: {}\n");
    expect(needsDocker(null, dir)).toBe(true);
  });
});

describe("repoNameFrom", () => {
  it.each([
    ["https://example.com/acme/shop.git", "shop"],
    ["git@example.com:acme/shop.git", "shop"],
    ["file:///srv/git/shop", "shop"],
    ["../repos/shop/", "shop"],
  ])("%s → %s", (spec, name) => expect(repoNameFrom(spec)).toBe(name));
});
