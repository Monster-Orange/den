/**
 * AG-0.5: the runtime catalog. Every vendor CLI Den knows how to find
 * (Claude Code, Codex CLI, Gemini CLI, Grok Build), shipped as data and
 * checked by one validator, which a distribution's and user.yml's entries
 * go through too.
 *
 *   - discovery: AG-0.1's search for every entry, installed first, each
 *     with its version; the interactive shell (`$SHELL -ilc`) asked once,
 *     only while a runtime is still missing, and named as the source;
 *   - paths, this machine's only: the workspace's wins over user.yml's,
 *     which wins over what the search finds;
 *   - Set path runs the version command and refuses a path that isn't
 *     that runtime;
 *   - launch: an installed runtime other than Claude Code runs as its own
 *     CLI in the workspace's directory, with no MCP config.
 *
 * Fake bins (`#!/bin/sh` scripts) in temp dirs and a fake shell only:
 * no test runs a vendor's real CLI or this machine's login shell.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import {
  BUILTIN_CATALOG,
  entryDirs,
  softNewlineSeq,
  validateCatalog,
  validateCatalogEntry,
} from "../../../src/shared/agents/catalog.js";
import {
  clearVersionCache,
  resetInteractivePath,
} from "../../../src/shared/agents/runtime-search.js";
import {
  listRuntimes,
  resolveAgentsDeps,
  setRuntimePath,
  startAgent,
} from "../../../src/ui/cli/agent-ops.js";
import { cmdAgents } from "../../../src/ui/cli/agents-command.js";
import { cleanupRigs, rig, type Rig } from "./helpers/rig.js";

afterEach(async () => {
  resetInteractivePath();
  clearVersionCache();
  await cleanupRigs();
});

function write(file: string, content: string, mode = 0o755): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, { mode });
  return file;
}

/** A CLI that prints `version` for --version and records any other run. */
const fakeCli = (ran: string, version: string) =>
  `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "${version}"; exit 0; fi\necho "$@" >> "${ran}"\nexit 1\n`;

/** Fake codex on the rig's PATH (its bin dir), printing codex-cli's line. */
function codexOnPath(r: Rig): string {
  return write(
    path.join(path.dirname(r.claude), "codex"),
    fakeCli(r.ran, "codex-cli 0.50.0"),
  );
}

const ids = (rows: { id: string }[]) => rows.map((x) => x.id);

describe("the catalog", () => {
  it("ships Claude Code, Codex CLI, Gemini CLI and Grok Build, each valid by its own validator", () => {
    expect(ids(BUILTIN_CATALOG)).toEqual([
      "den-claude",
      "codex",
      "gemini",
      "grok",
    ]);
    for (const e of BUILTIN_CATALOG) {
      expect(validateCatalogEntry(e, e.id)).toEqual(e);
      expect(e.version.args).toEqual(["--version"]);
      expect(e.launch.argv[0]).toBe("{bin}");
    }
    expect(
      BUILTIN_CATALOG.map((e) => [e.id, e.vendor, e.bins.join(",")]),
    ).toEqual([
      ["den-claude", "Anthropic", "claude"],
      ["codex", "OpenAI", "codex"],
      ["gemini", "Google", "gemini"],
      ["grok", "xAI", "grok"],
    ]);
  });

  it("the validator refuses what it can't use, naming the key; an id already in the catalog is refused", () => {
    const ok = {
      id: "aider-x",
      vendor: "Someone",
      name: "Aider X",
      bins: ["aider-x"],
      version: { args: ["--version"], identity: { output: "aider" } },
      dirs: ["~/.local/bin", "$AIDER_DIR", "{system}", "/opt/aider/bin"],
      launch: { argv: ["{bin}", "--no-auto-commits"] },
    };
    expect(validateCatalogEntry(ok, "x").id).toBe("aider-x");
    const bad: Array<[Record<string, unknown>, RegExp]> = [
      [{ ...ok, extra: 1 }, /x\.extra: unknown key/],
      [{ ...ok, id: "Bad Id" }, /x\.id:/],
      [{ ...ok, id: "generic" }, /x\.id:/],
      [{ ...ok, bins: ["/usr/bin/aider"] }, /x\.bins\[0\]: .* no path/],
      [
        { ...ok, launch: { argv: ["aider"] } },
        /launch\.argv\[0\]: must be "\{bin\}"/,
      ],
      [
        { ...ok, version: { args: ["--version"], identity: {} } },
        /identity: needs output, package or realpath_under/,
      ],
      [
        { ...ok, version: { args: ["--version"], identity: { output: "(" } } },
        /identity\.output: .* not a valid pattern/,
      ],
      [{ ...ok, dirs: ["relative/bin"] }, /x\.dirs\[0\]:/],
      [{ ...ok, dirs: ["~/../etc"] }, /x\.dirs\[0\]:/],
    ];
    for (const [entry, why] of bad)
      expect(() => validateCatalogEntry(entry, "x")).toThrow(why);
    expect(() =>
      validateCatalog([{ ...ok, id: "codex" }], "agents.runtime_catalog"),
    ).toThrow(
      /agents\.runtime_catalog\[0\]\.id: "codex" is already in the catalog/,
    );
    expect(() => validateCatalog({}, "agents.runtime_catalog")).toThrow(
      /must be a list/,
    );
  });

  it("each entry's terminal traits (AG-4b): Shift+Enter's soft newline, the session name's source, the OSC title (off everywhere)", () => {
    expect(
      BUILTIN_CATALOG.map((e) => [
        e.id,
        e.softNewline,
        e.sessionName,
        e.titleFromOsc,
      ]),
    ).toEqual([
      // Claude Code: ESC CR (Option+Enter, what /terminal-setup binds);
      // its /rename title is read from the transcript: unofficial.
      ["den-claude", "esc-cr", "unofficial", undefined],
      // Codex CLI: Ctrl+J (LF) inserts a newline.
      ["codex", "lf", undefined, undefined],
      // Gemini CLI: Alt+Enter (ESC CR) inserts a newline.
      ["gemini", "esc-cr", undefined, undefined],
      // Grok Build: no documented key; the default.
      ["grok", undefined, undefined, undefined],
    ]);
    expect(softNewlineSeq(BUILTIN_CATALOG[0])).toBe("\x1b\r");
    expect(softNewlineSeq(BUILTIN_CATALOG[1])).toBe("\n");
    // The default is ESC CR; none is Enter.
    expect(softNewlineSeq(BUILTIN_CATALOG[3])).toBe("\x1b\r");
    expect(softNewlineSeq(undefined)).toBe("\x1b\r");
    expect(softNewlineSeq({ softNewline: "none" })).toBe("\r");
    const ok = {
      id: "aider-y",
      vendor: "Someone",
      name: "Aider Y",
      bins: ["aider-y"],
      version: { args: ["--version"], identity: { output: "aider" } },
      dirs: [],
      launch: { argv: ["{bin}"] },
    };
    expect(
      validateCatalogEntry(
        { ...ok, softNewline: "none", titleFromOsc: true },
        "x",
      ),
    ).toMatchObject({ softNewline: "none", titleFromOsc: true });
    expect(() =>
      validateCatalogEntry({ ...ok, softNewline: "\x1b\r" }, "x"),
    ).toThrow(/x\.softNewline: .*esc-cr, lf, none/);
    expect(() =>
      validateCatalogEntry({ ...ok, titleFromOsc: "yes" }, "x"),
    ).toThrow(/x\.titleFromOsc: must be true or false/);
    expect(() =>
      validateCatalogEntry({ ...ok, sessionName: "maybe" }, "x"),
    ).toThrow(/x\.sessionName:/);
  });

  it("an entry's directories: ~ from HOME, $NAME only when set, {system} as given", () => {
    const e = {
      dirs: ["$CODEX_INSTALL_DIR", "~/.local/bin", "{system}", "/x"],
    };
    const sys = () => ["/sys/bin"];
    expect(entryDirs(e, "/h", {}, sys)).toEqual([
      "/h/.local/bin",
      "/sys/bin",
      "/x",
    ]);
    expect(entryDirs(e, undefined, { CODEX_INSTALL_DIR: "/c" }, sys)).toEqual([
      "/c",
      "/sys/bin",
      "/x",
    ]);
  });
});

describe("discovery", () => {
  it("lists every catalog runtime, installed first with its version; generic last", async () => {
    const r = await rig();
    codexOnPath(r);
    const d = resolveAgentsDeps(r.deps);
    const rows = await listRuntimes(d);
    expect(ids(rows)).toEqual([
      "den-claude",
      "codex",
      "gemini",
      "grok",
      "generic",
    ]);
    expect(rows[1]).toMatchObject({
      id: "codex",
      label: "Codex CLI",
      vendor: "OpenAI",
      available: true,
      version: "0.50.0",
      source: "PATH",
      denTools: false,
    });
    expect(rows[0]).toMatchObject({ id: "den-claude", denTools: true });
    expect(rows[2]).toMatchObject({ id: "gemini", available: false });
    // Not installed: after the installed one, whatever the catalog order.
    fs.rmSync(r.claude);
    const again = await listRuntimes(d);
    expect(ids(again)).toEqual([
      "codex",
      "den-claude",
      "gemini",
      "grok",
      "generic",
    ]);
    expect(fs.existsSync(r.ran)).toBe(false);
  });

  it("a runtime still missing: the interactive shell is asked once (-ilc, stdin closed), and named as the source", async () => {
    const r = await rig();
    const asked = path.join(r.dir, "shell-asked");
    const late = path.join(r.dir, "rc-bin");
    write(path.join(late, "gemini"), fakeCli(r.ran, "0.9.1"));
    // Its PATH only as an interactive shell (an rc file's PATH).
    const shell = write(
      path.join(r.dir, "fake-shell"),
      [
        "#!/bin/sh",
        `echo "$1" >> "${asked}"`,
        'if [ -t 0 ]; then echo "stdin open" >> "' + asked + '"; fi',
        `case "$1" in -ilc) P="${late}:/usr/bin";; *) P="/usr/bin";; esac`,
        "printf '__DEN_PATH_BEGIN__%s__DEN_PATH_END__' \"$P\"",
        "",
      ].join("\n"),
    );
    r.deps.env = { ...r.deps.env, DEN_LOGIN_SHELL: shell };
    const d = resolveAgentsDeps(r.deps);
    const rows = await listRuntimes(d);
    expect(rows.find((x) => x.id === "gemini")).toMatchObject({
      available: true,
      path: path.join(late, "gemini"),
      source: "interactive-shell",
    });
    await listRuntimes(d);
    expect(fs.readFileSync(asked, "utf-8").trim().split("\n")).toEqual([
      "-ilc",
    ]);
    // doctor names the source.
    r.out.length = 0;
    await cmdAgents(["doctor"], { ...r.deps, loginPath: async () => {} });
    expect(r.out).toContain(
      `  path      ${path.join(late, "gemini")} (interactive shell PATH)`,
    );
  });

  it("nothing missing: the interactive shell is never asked", async () => {
    const r = await rig();
    const asked = path.join(r.dir, "shell-asked");
    const shell = write(
      path.join(r.dir, "fake-shell"),
      `#!/bin/sh\necho "$1" >> "${asked}"\n`,
    );
    for (const b of ["codex", "gemini", "grok"])
      write(path.join(path.dirname(r.claude), b), fakeCli(r.ran, `${b} 1.0.0`));
    r.deps.env = { ...r.deps.env, DEN_LOGIN_SHELL: shell };
    await listRuntimes(resolveAgentsDeps(r.deps));
    expect(fs.existsSync(asked)).toBe(false);
  });

  it("a distribution's and user.yml's entries are listed, through the same validator", async () => {
    const r = await rig();
    const entry = (id: string) => ({
      id,
      vendor: "Someone",
      name: id.toUpperCase(),
      bins: [id],
      version: { args: ["--version"], identity: { output: id } },
      dirs: [],
      launch: { argv: ["{bin}"] },
    });
    r.config.runtimeCatalog = validateCatalog(
      [entry("dist-cli")],
      "agents.runtime_catalog",
    );
    r.userCatalog = [entry("mine-cli")];
    write(
      path.join(path.dirname(r.claude), "mine-cli"),
      fakeCli(r.ran, "mine-cli 2.0.0"),
    );
    const d = resolveAgentsDeps(r.deps);
    const rows = await listRuntimes(d);
    expect(rows.find((x) => x.id === "mine-cli")).toMatchObject({
      available: true,
      version: "2.0.0",
      denTools: false,
    });
    expect(rows.find((x) => x.id === "dist-cli")).toMatchObject({
      available: false,
    });
    // Taken out of the config: no runtime any more.
    r.userCatalog = undefined;
    expect(ids(await listRuntimes(d))).not.toContain("mine-cli");
    // A user.yml entry with a built-in's id is refused, naming the key.
    r.userCatalog = [entry("codex")];
    await expect(listRuntimes(d)).rejects.toThrow(
      /agents\.runtime_catalog \(user\.yml\)\[0\]\.id: "codex" is already in the catalog/,
    );
  });
});

describe("paths, per machine: workspace, then global, then detected", () => {
  it("the workspace's path wins for its agents, user.yml's elsewhere, the search when neither", async () => {
    const r = await rig();
    codexOnPath(r);
    const global = write(
      path.join(r.dir, "g", "codex"),
      fakeCli(r.ran, "codex-cli 0.51.0"),
    );
    const north = write(
      path.join(r.dir, "n", "codex"),
      fakeCli(r.ran, "codex-cli 0.52.0"),
    );
    const d = resolveAgentsDeps(r.deps);
    const codex = async (ws?: string) =>
      (await listRuntimes(d, ws)).find((x) => x.id === "codex")!;
    expect(await codex("north")).toMatchObject({ source: "PATH" });
    r.runtimeBins.codex = global;
    expect(await codex("north")).toMatchObject({
      path: global,
      source: "setting",
    });
    r.wsBins.north = { codex: north };
    expect(await codex("north")).toMatchObject({
      path: north,
      source: "workspace",
      version: "0.52.0",
      workspaceSetting: "workspaces.north.agents.runtimes.codex.bin",
    });
    expect(await codex("south")).toMatchObject({
      path: global,
      source: "setting",
    });
    expect(await codex()).toMatchObject({ path: global, source: "setting" });
    // A bad workspace path is refused with its key; nothing falls back.
    r.wsBins.north = { codex: "codex" };
    expect(await codex("north")).toMatchObject({
      available: false,
      source: "workspace",
      why: 'workspaces.north.agents.runtimes.codex.bin: "codex" is not an absolute path',
    });
  });

  it("Set path runs the version command and refuses a path that isn't that runtime; Clear removes it", async () => {
    const r = await rig();
    const d = resolveAgentsDeps(r.deps);
    const other = write(
      path.join(r.dir, "o", "codex"),
      fakeCli(r.ran, "1.2.3"),
    );
    const silent = write(path.join(r.dir, "s", "codex"), "#!/bin/sh\nexit 0\n");
    const failing = write(
      path.join(r.dir, "f", "codex"),
      "#!/bin/sh\nexit 3\n",
    );
    const plain = write(path.join(r.dir, "p", "codex"), "x", 0o644);
    const codex = write(
      path.join(r.dir, "c", "codex"),
      fakeCli(r.ran, "codex-cli 0.50.0"),
    );
    const set = (bin: string | null, ws?: string) =>
      setRuntimePath(d, {
        id: "codex",
        scope: ws ? "workspace" : "global",
        ...(ws ? { workspace: ws } : {}),
        bin,
      });
    await expect(set(other)).rejects.toThrow(/is not Codex CLI/);
    await expect(set(silent)).rejects.toThrow(
      /printed no version: not Codex CLI/,
    );
    await expect(set(failing)).rejects.toThrow(/failed: not Codex CLI/);
    await expect(set(plain)).rejects.toThrow(/is not an executable file/);
    await expect(set("codex")).rejects.toThrow(/is not an absolute path/);
    expect(r.runtimeBins).toEqual({});
    expect(await set(codex)).toMatchObject({
      id: "codex",
      path: codex,
      source: "setting",
      version: "0.50.0",
    });
    expect(r.runtimeBins).toEqual({ codex });
    expect(await set(codex, "south")).toMatchObject({ source: "workspace" });
    expect(r.wsBins).toEqual({ south: { codex } });
    await expect(set(codex, "nowhere")).rejects.toThrow(/does not exist/);
    await set(null, "south");
    await set(null);
    expect(r.runtimeBins).toEqual({});
    expect(r.wsBins).toEqual({ south: {} });
    // generic has no CLI of its own.
    await expect(
      setRuntimePath(d, { id: "generic", scope: "global", bin: codex }),
    ).rejects.toThrow(/can't be set/);
    // Only --version ever ran.
    expect(fs.existsSync(r.ran)).toBe(false);
  });

  it("a version-only CLI (Gemini) is known by its npm package or refused", async () => {
    const r = await rig();
    const d = resolveAgentsDeps(r.deps);
    const pkg = path.join(
      r.dir,
      "lib",
      "node_modules",
      "@google",
      "gemini-cli",
    );
    write(
      path.join(pkg, "package.json"),
      '{"name":"@google/gemini-cli"}',
      0o644,
    );
    const real = write(
      path.join(pkg, "dist", "index.js"),
      fakeCli(r.ran, "0.9.1"),
    );
    const link = path.join(r.dir, "bin2", "gemini");
    fs.mkdirSync(path.dirname(link));
    fs.symlinkSync(real, link);
    const impostor = write(
      path.join(r.dir, "x", "gemini"),
      fakeCli(r.ran, "0.9.1"),
    );
    const set = (bin: string) =>
      setRuntimePath(d, { id: "gemini", scope: "global", bin });
    await expect(set(impostor)).rejects.toThrow(/is not Gemini CLI/);
    expect(await set(link)).toMatchObject({
      available: true,
      version: "0.9.1",
    });
  });
});

describe("launch", () => {
  it("an installed runtime other than Claude Code runs as its own CLI in the workspace's directory, with no MCP config", async () => {
    const r = await rig();
    const codex = codexOnPath(r);
    const d = resolveAgentsDeps(r.deps);
    const s = await startAgent(d, {
      workspace: "north",
      persona: "planner",
      runtime: "codex",
    });
    const pty = r.made.at(-1)!;
    expect([pty.file, ...pty.args]).toEqual([codex]);
    expect(pty.opts.cwd).toBe(r.wsDir("north"));
    expect(s.rec.runtime).toBe("codex");
    expect(s.warnings.join("\n")).toMatch(
      /Den's tools \(MCP\) and permission modes are coming/,
    );
    expect(
      fs.existsSync(path.join(r.stateDir, "agents", "planner", "mcp.json")),
    ).toBe(false);
    // The workspace's own path is the one it runs.
    const north = write(
      path.join(r.dir, "n", "codex"),
      fakeCli(r.ran, "codex-cli 0.52.0"),
    );
    r.wsBins.north = { codex: north };
    await startAgent(d, {
      workspace: "north",
      persona: "reviewer",
      runtime: "codex",
    });
    expect(r.made.at(-1)!.file).toBe(north);
  });

  it("a runtime that isn't installed is refused before anything starts", async () => {
    const r = await rig();
    const d = resolveAgentsDeps(r.deps);
    const made = r.made.length;
    await expect(
      startAgent(d, {
        workspace: "north",
        persona: "planner",
        runtime: "grok",
      }),
    ).rejects.toThrow(/grok is unavailable: grok not found/);
    expect(r.made.length).toBe(made);
  });
});
