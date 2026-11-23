/**
 * Issue 988, slice 2: what the launcher runs is the person's, never the
 * agents' login's, and nothing from the login's home or the folder it was
 * started in is loaded as code.
 *
 *   runtimeWritableProblems  node, Den's CLI, Den's folder (node_modules
 *                            and all) and every folder above them: none
 *                            may be the agents' login's, writable by its
 *                            group or by anyone (a sticky folder like /tmp
 *                            is fine above them)
 *   the launcher             starts in the login's home, whatever folder
 *                            sudo was run from; NODE_OPTIONS, NODE_PATH,
 *                            a node_modules or a .npmrc there or in the
 *                            caller's folder load nothing
 *
 * Invented names.
 */
import { afterAll, describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  launcherScript,
  runtimeWritableProblems,
} from "../../../src/shared/agents/os-user.js";

const tmp = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), "den-os-user-launch-988-")),
);
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const AGENTS = { uid: 455, gid: 455 };

describe("issue 988: nothing the launcher runs is the agents' login's to change", () => {
  /** A fake engine: <engine>/dist/cli.js and <engine>/node_modules/dep/index.js. */
  function engine(name: string) {
    const e = path.join(tmp, name);
    fs.mkdirSync(path.join(e, "dist"), { recursive: true });
    fs.mkdirSync(path.join(e, "node_modules", "dep"), { recursive: true });
    fs.writeFileSync(path.join(e, "dist", "cli.js"), "");
    fs.writeFileSync(path.join(e, "node_modules", "dep", "index.js"), "");
    fs.chmodSync(e, 0o755);
    return e;
  }
  type St = { uid: number; gid: number; mode: number };
  /** The real stat, with some paths made to look otherwise. */
  const statWith =
    (over: Record<string, Partial<St>>) =>
    (p: string): St => {
      const s = fs.lstatSync(p);
      return { uid: s.uid, gid: s.gid, mode: s.mode, ...(over[p] ?? {}) };
    };

  it("all the person's: no problems", () => {
    const e = engine("ok");
    expect(
      runtimeWritableProblems(
        {
          bin: process.execPath,
          script: path.join(e, "dist", "cli.js"),
          engineRoot: e,
        },
        AGENTS,
        { stat: statWith({}) },
      ),
    ).toEqual([]);
  });

  it("a file deep in node_modules the login owns, or its group can write, is named", () => {
    const e = engine("deep");
    const dep = path.join(e, "node_modules", "dep", "index.js");
    for (const over of [
      { uid: AGENTS.uid },
      { gid: AGENTS.gid, mode: 0o100664 },
      { mode: 0o100666 },
    ]) {
      const p = runtimeWritableProblems(
        {
          bin: process.execPath,
          script: path.join(e, "dist", "cli.js"),
          engineRoot: e,
        },
        AGENTS,
        { stat: statWith({ [dep]: over }) },
      );
      expect(p.join("\n")).toContain(dep);
    }
  });

  it("a folder above Den's CLI the login could change is named; a sticky one is fine", () => {
    const e = engine("above");
    const parent = path.dirname(e);
    const bad = runtimeWritableProblems(
      {
        bin: process.execPath,
        script: path.join(e, "dist", "cli.js"),
        engineRoot: e,
      },
      AGENTS,
      { stat: statWith({ [parent]: { mode: 0o40777 } }) },
    );
    expect(bad.join("\n")).toContain(parent);
    const sticky = runtimeWritableProblems(
      {
        bin: process.execPath,
        script: path.join(e, "dist", "cli.js"),
        engineRoot: e,
      },
      AGENTS,
      { stat: statWith({ [parent]: { mode: 0o41777 } }) },
    );
    expect(sticky).toEqual([]);
  });

  it("node itself, or its folder, is checked too", () => {
    const e = engine("node");
    const node = fs.realpathSync(process.execPath);
    const p = runtimeWritableProblems(
      {
        bin: process.execPath,
        script: path.join(e, "dist", "cli.js"),
        engineRoot: e,
      },
      AGENTS,
      { stat: statWith({ [node]: { uid: AGENTS.uid } }) },
    );
    expect(p.join("\n")).toContain(node);
  });
});

describe("issue 988: nothing from the login's home or the caller's folder is loaded", () => {
  const home = path.join(tmp, "home");
  const caller = path.join(tmp, "caller");
  const marker = path.join(tmp, "LOADED");
  const evil = `require("fs").writeFileSync(${JSON.stringify(marker)}, __filename);\n`;
  for (const d of [home, caller]) {
    fs.mkdirSync(path.join(d, "node_modules", "dep"), { recursive: true });
    fs.writeFileSync(path.join(d, "node_modules", "dep", "index.js"), evil);
    fs.writeFileSync(
      path.join(d, "node_modules", "dep", "package.json"),
      '{"main":"index.js"}',
    );
    fs.writeFileSync(path.join(d, "evil.cjs"), evil);
    fs.writeFileSync(
      path.join(d, ".npmrc"),
      "node-options=--require ./evil.cjs\n",
    );
  }
  // The runtime: prints its folder, then tries the bare name "dep".
  const engineDir = path.join(tmp, "engine");
  fs.mkdirSync(engineDir, { recursive: true });
  const script = path.join(engineDir, "cli.cjs");
  fs.writeFileSync(
    script,
    'console.log("CWD " + process.cwd()); try { require("dep"); console.log("DEP loaded"); } catch { console.log("DEP none"); }\n',
  );
  const launcher = path.join(tmp, "den-agent-launch");
  fs.writeFileSync(
    launcher,
    launcherScript({
      person: "robin",
      user: "den-agents-robin",
      home,
      runtime: { bin: process.execPath, script },
    }),
  );

  it("starts in the login's home, loads no module from there or the caller's folder, and takes no NODE_OPTIONS", () => {
    const r = spawnSync(
      "/bin/sh",
      [launcher, "scout", "0123456789abcdef0123456789abcdef"],
      {
        cwd: caller,
        encoding: "utf-8",
        env: {
          NODE_OPTIONS: `--require ${path.join(caller, "evil.cjs")}`,
          NODE_PATH: path.join(caller, "node_modules"),
          npm_config_node_options: "--require ./evil.cjs",
        },
      },
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`CWD ${home}`);
    expect(r.stdout).toContain("DEP none");
    expect(fs.existsSync(marker)).toBe(false);
  });
});
