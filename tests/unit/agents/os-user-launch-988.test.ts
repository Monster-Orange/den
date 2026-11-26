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
  const statWith =
    (over: Record<string, Partial<St>>) =>
    (p: string): St => {
      const s = fs.lstatSync(p);
      const real =
        p === tmp || p.startsWith(tmp + path.sep)
          ? { uid: s.uid, gid: s.gid, mode: s.mode }
          : { uid: 0, gid: 0, mode: (s.mode & 0o170000) | 0o755 };
      return { ...real, ...(over[p] ?? {}) };
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

describe("issue 988: every group the login is in, and every link under the engine", () => {
  type St = { uid: number; gid: number; mode: number };
  const fake =
    (over: Record<string, Partial<St>>) =>
    (p: string): St => {
      const s = fs.lstatSync(p);
      const real =
        p === tmp || p.startsWith(tmp + path.sep)
          ? { uid: s.uid, gid: s.gid, mode: s.mode }
          : { uid: 0, gid: 0, mode: (s.mode & 0o170000) | 0o755 };
      return { ...real, ...(over[p] ?? {}) };
    };
  const LOGIN = { uid: 455, gid: 455, gids: [455, 20, 812] };
  function linked(name: string) {
    const e = path.join(tmp, name, "engine");
    const store = path.join(tmp, name, "store", "pkg");
    fs.mkdirSync(path.join(e, "dist"), { recursive: true });
    fs.mkdirSync(path.join(e, "node_modules"), { recursive: true });
    fs.mkdirSync(store, { recursive: true });
    fs.writeFileSync(path.join(e, "dist", "cli.js"), "");
    fs.writeFileSync(path.join(store, "index.js"), "");
    fs.symlinkSync(store, path.join(e, "node_modules", "pkg"));
    fs.symlinkSync(e, path.join(e, "node_modules", "loop"));
    return { e, store, file: path.join(store, "index.js") };
  }
  const run = (e: string, stat: (p: string) => St) =>
    runtimeWritableProblems(
      {
        bin: process.execPath,
        script: path.join(e, "dist", "cli.js"),
        engineRoot: e,
      },
      LOGIN,
      { stat },
    ).join("\n");

  it("a file another of the login's groups can write is named", () => {
    const { e } = linked("groups");
    const cli = path.join(e, "dist", "cli.js");
    expect(run(e, fake({ [cli]: { gid: 812, mode: 0o100664 } }))).toContain(
      cli,
    );
    expect(run(e, fake({ [cli]: { gid: 813, mode: 0o100664 } }))).toBe("");
  });

  it("a link under the engine is followed: its target, what's in it and the folders above it", () => {
    const { e, store, file } = linked("links");
    expect(run(e, fake({}))).toBe("");
    expect(run(e, fake({ [file]: { uid: 455 } }))).toContain(file);
    const above = path.dirname(store);
    expect(run(e, fake({ [above]: { mode: 0o40777 } }))).toContain(above);
  });

  it("a link's own mode is no problem (Linux shows every link as 0777): its target and folder are what count", () => {
    const { e } = linked("linkmode");
    const pkg = path.join(e, "node_modules", "pkg");
    const loop = path.join(e, "node_modules", "loop");
    expect(
      run(e, fake({ [pkg]: { mode: 0o120777 }, [loop]: { mode: 0o120777 } })),
    ).toBe("");
  });

  it("a link the agents' login owns is named, whatever its mode", () => {
    const { e } = linked("linkowner");
    const pkg = path.join(e, "node_modules", "pkg");
    expect(run(e, fake({ [pkg]: { uid: 455, mode: 0o120755 } }))).toContain(
      pkg,
    );
  });

  it("a link under the engine to nothing is named: the login might make what it points at", () => {
    const { e } = linked("dangling");
    const open = path.join(tmp, "dangling", "open");
    fs.mkdirSync(open);
    const link = path.join(e, "node_modules", "gone");
    fs.symlinkSync(path.join(open, "missing.js"), link);
    expect(run(e, fake({}))).toContain(link);
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
