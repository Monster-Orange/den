/**
 * Engine root vs distribution root.
 *
 * In a distribution, Den lives in node_modules/@monster-orange/den (the
 * engine root) and the distribution's den.yml sits at its own root. Engine
 * files must resolve from the first, data from the second; bin/den must hand
 * both to the CLI without mistaking the engine dir for a distribution.
 */
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  distPath,
  engineBin,
  enginePath,
  tsxCommand,
} from "../../src/shared/engine.js";
import { getDistRoot, getEngineRoot } from "../../src/shared/paths.js";
import { renderDistribution } from "../../src/ui/cli/create.js";

const REAL_BIN = path.resolve("bin/den");

/** A fake tsx that reports what bin/den handed it (only Den's own vars). */
const FAKE_TSX = `#!/bin/sh
echo "DEN_ROOT=\${DEN_ROOT:-}"
echo "DEN_ENGINE_ROOT=\${DEN_ENGINE_ROOT:-}"
echo "OP_ACCOUNT_SET=\${OP_ACCOUNT+yes}"
echo "ENTRY=$1"
shift
echo "ARGS=$*"
`;

function write(file: string, content: string, mode?: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  if (mode) fs.chmodSync(file, mode);
}

/** An engine dir: a copy of the real bin/den plus the entry points it runs. */
function makeEngine(dir: string): void {
  write(
    path.join(dir, "bin", "den"),
    fs.readFileSync(REAL_BIN, "utf-8"),
    0o755,
  );
  write(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "@monster-orange/den", version: "9.9.9" }),
  );
  write(path.join(dir, "src/ui/cli/index.ts"), "");
  write(path.join(dir, "src/ui/cli/create-main.ts"), "");
}

/** The child env: the caller's, without any Den root variables. */
function cleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.DEN_ROOT;
  delete env.DEN_ENGINE_ROOT;
  delete env.DEN_USE_DIST;
  delete env.OP_ACCOUNT;
  return { ...env, ...extra };
}

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv) {
  const r = spawnSync(cmd, args, { env, encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`${cmd} exited ${r.status}: ${r.stderr}`);
  const out: Record<string, string> = {};
  for (const line of r.stdout.trim().split("\n")) {
    const i = line.indexOf("=");
    out[line.slice(0, i)] = line.slice(i + 1);
  }
  return out;
}

describe("bin/den: engine root and distribution root", () => {
  let tmp: string;
  let dist: string;
  let engine: string;

  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-roots-")));
    dist = path.join(tmp, "acme");
    engine = path.join(dist, "node_modules", "@monster-orange", "den");
    makeEngine(engine);
    // tsx hoisted into the distribution, as npm installs it.
    write(path.join(dist, "node_modules", ".bin", "tsx"), FAKE_TSX, 0o755);
    const files = renderDistribution({ name: "acme", denVersion: "9.9.9" });
    for (const [rel, content] of Object.entries(files))
      write(
        path.join(dist, rel),
        content,
        rel.startsWith("bin/") ? 0o755 : undefined,
      );
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("the distribution shim sets DEN_ROOT to the distribution, the engine to node_modules", () => {
    const out = run(path.join(dist, "bin", "acme"), ["status"], cleanEnv());
    expect(out.DEN_ROOT).toBe(dist);
    expect(out.DEN_ENGINE_ROOT).toBe(engine);
    expect(out.DEN_ROOT).not.toBe(out.DEN_ENGINE_ROOT);
    expect(out.ENTRY).toBe(path.join(engine, "src/ui/cli/index.ts"));
    expect(out.ARGS).toBe("status");
  });

  it("run directly from node_modules, it never takes the engine dir as the distribution", () => {
    const out = run(path.join(engine, "bin", "den"), ["status"], cleanEnv());
    expect(out.DEN_ROOT).toBe("");
    expect(out.DEN_ENGINE_ROOT).toBe(engine);
  });

  it("in Den's own checkout (engine dir holds den.yml) both roots are that dir", () => {
    const checkout = path.join(tmp, "den");
    makeEngine(checkout);
    write(path.join(checkout, "den.yml"), "product:\n  name: den\n");
    write(path.join(checkout, "node_modules", ".bin", "tsx"), FAKE_TSX, 0o755);
    const out = run(path.join(checkout, "bin", "den"), [], cleanEnv());
    expect(out.DEN_ROOT).toBe(checkout);
    expect(out.DEN_ENGINE_ROOT).toBe(checkout);
  });

  it("keeps a DEN_ROOT the caller already set", () => {
    write(path.join(engine, "den.yml"), "product:\n  name: den\n");
    const out = run(
      path.join(engine, "bin", "den"),
      [],
      cleanEnv({ DEN_ROOT: dist }),
    );
    expect(out.DEN_ROOT).toBe(dist);
  });

  it("adds no backend account of its own (SEC-0): OP_ACCOUNT only if the caller set it", () => {
    const bare = run(path.join(engine, "bin", "den"), ["status"], cleanEnv());
    expect(bare.OP_ACCOUNT_SET).toBe("");
    const own = run(
      path.join(engine, "bin", "den"),
      ["status"],
      cleanEnv({ OP_ACCOUNT: "team.example" }),
    );
    expect(own.OP_ACCOUNT_SET).toBe("yes");
  });

  it("routes `create` to its own entry point, without the word create", () => {
    const out = run(
      path.join(engine, "bin", "den"),
      ["create", "shop", "--title", "Shop"],
      cleanEnv(),
    );
    expect(out.ENTRY).toBe(path.join(engine, "src/ui/cli/create-main.ts"));
    expect(out.ARGS).toBe("shop --title Shop");
  });
});

describe("engine helpers resolve from two roots", () => {
  let tmp: string;
  const saved = {
    root: process.env.DEN_ROOT,
    engine: process.env.DEN_ENGINE_ROOT,
  };

  beforeEach(() => {
    tmp = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "den-helpers-")),
    );
  });

  afterEach(() => {
    for (const [k, v] of [
      ["DEN_ROOT", saved.root],
      ["DEN_ENGINE_ROOT", saved.engine],
    ] as const)
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("enginePath/distPath/tsxCommand use the engine and distribution roots", () => {
    const dist = path.join(tmp, "acme");
    const engine = path.join(dist, "node_modules", "@monster-orange", "den");
    write(path.join(dist, "den.yml"), "product:\n  name: acme\n");
    write(path.join(dist, "node_modules", ".bin", "tsx"), "", 0o755);
    fs.mkdirSync(engine, { recursive: true });
    process.env.DEN_ROOT = dist;
    process.env.DEN_ENGINE_ROOT = engine;

    expect(getDistRoot()).toBe(dist);
    expect(getEngineRoot()).toBe(engine);
    expect(enginePath("src/pillars/api")).toBe(
      path.join(engine, "src/pillars/api"),
    );
    expect(distPath("reports")).toBe(path.join(dist, "reports"));
    // npm hoists tsx into the distribution's node_modules: the walk finds it.
    expect(tsxCommand("src/pillars/perf/run.ts", "--env", "local")).toEqual({
      command: path.join(dist, "node_modules", ".bin", "tsx"),
      args: [path.join(engine, "src/pillars/perf/run.ts"), "--env", "local"],
    });
  });

  it("engineBin prefers the engine's own node_modules, else falls back to PATH", () => {
    const engine = path.join(tmp, "engine");
    write(path.join(engine, "node_modules", ".bin", "playwright"), "", 0o755);
    expect(engineBin("playwright", engine)).toBe(
      path.join(engine, "node_modules", ".bin", "playwright"),
    );
    expect(engineBin("no-such-binary-anywhere", engine)).toBe(
      "no-such-binary-anywhere",
    );
  });
});
