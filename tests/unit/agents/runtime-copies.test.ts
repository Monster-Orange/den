/**
 * Issue 456: Den finds the CLI the person's terminal runs, lists the other
 * copies it found, and never runs a copy it didn't choose or one macOS
 * has quarantined.
 *
 *   1. the interactive shell's PATH (`$SHELL -ilc`) is the first choice,
 *      asked once; the login shell, PATH and install directories are
 *      fallbacks;
 *   2. more than one copy: the chosen one, and the others with the
 *      version their install says (read from files, never run);
 *   3. a copy with com.apple.quarantine is never run: "quarantined, not
 *      run" (the attribute is read by an injectable reader; here a fake);
 *   4. the version command runs on the chosen copy only.
 *
 * Fake `codex` scripts in temp dirs and a fake shell only: no test runs a
 * vendor's real CLI, this machine's shell or the real xattr.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import {
  clearVersionCache,
  installVersion,
  isQuarantined,
  resetInteractivePath,
  runtimeVersion,
  setQuarantineReader,
  versionOutput,
} from "../../../src/shared/agents/runtime-search.js";
import {
  listRuntimes,
  resolveAgentsDeps,
  setRuntimePath,
} from "../../../src/ui/cli/agent-ops.js";
import { doctorLines } from "../../../src/ui/cli/agents-command.js";
import { runtimeRowHtml } from "../../../src/ui/server/public/settings-registry.js";
import { cleanupRigs, rig, type Rig } from "./helpers/rig.js";

afterEach(async () => {
  resetInteractivePath();
  clearVersionCache();
  setQuarantineReader(undefined);
  await cleanupRigs();
});

function write(file: string, content: string, mode = 0o755): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, { mode });
  return file;
}

/** A codex that prints its version for --version and records every run. */
const fakeCodex = (ran: string, version: string) =>
  `#!/bin/sh\necho "$@" >> "${ran}"\nif [ "$1" = "--version" ]; then echo "codex-cli ${version}"; exit 0; fi\nexit 1\n`;

interface Copies {
  r: Rig;
  /** The newer codex, first on the interactive shell's PATH. */
  newer: string;
  newerRan: string;
  /** The older codex: a Homebrew-style keg, linked from a well-known dir. */
  older: string;
  olderRan: string;
  /** What the fake shell was asked, one flag per line. */
  asked: string;
}

/**
 * Two codex copies. The older one is Homebrew-style
 * (`Cellar/codex/0.30.0/bin/codex`, linked from `homebrew/bin`), and
 * `homebrew/bin` is a well-known dir (and on the plain login shell's
 * PATH). The newer one is first on the interactive shell's PATH only (an
 * rc file's PATH).
 */
async function twoCopies(): Promise<Copies> {
  const r = await rig();
  const keg = path.join(r.dir, "Cellar", "codex", "0.30.0", "bin", "codex");
  const olderRan = path.join(r.dir, "older-ran");
  write(keg, fakeCodex(olderRan, "0.30.0"));
  const brewBin = path.join(r.dir, "homebrew", "bin");
  fs.mkdirSync(brewBin, { recursive: true });
  const older = path.join(brewBin, "codex");
  fs.symlinkSync(keg, older);
  const rcBin = path.join(r.dir, "rc-bin");
  const newerRan = path.join(r.dir, "newer-ran");
  const newer = write(path.join(rcBin, "codex"), fakeCodex(newerRan, "0.60.0"));
  const asked = path.join(r.dir, "shell-asked");
  const shell = write(
    path.join(r.dir, "fake-shell"),
    [
      "#!/bin/sh",
      `echo "$1" >> "${asked}"`,
      `case "$1" in -ilc) P="${rcBin}:/usr/bin";; *) P="${brewBin}:/usr/bin";; esac`,
      "printf '__DEN_PATH_BEGIN__%s__DEN_PATH_END__' \"$P\"",
      "",
    ].join("\n"),
  );
  r.deps.env = {
    ...r.deps.env,
    DEN_LOGIN_SHELL: shell,
    DEN_RUNTIME_DIRS: brewBin,
  };
  return { r, newer, newerRan, older, olderRan, asked };
}

const ranLines = (f: string) =>
  fs.existsSync(f) ? fs.readFileSync(f, "utf-8").trim().split("\n") : [];

describe("issue 456: the copy the terminal runs", () => {
  it("(a) the newer codex, first on the interactive PATH, is chosen; the older one in a well-known dir is listed with its version", async () => {
    const c = await twoCopies();
    const d = resolveAgentsDeps(c.r.deps);
    const row = (await listRuntimes(d)).find((x) => x.id === "codex")!;
    expect(row).toMatchObject({
      available: true,
      path: c.newer,
      source: "interactive-shell",
      version: "0.60.0",
    });
    // The other copy: where, from which search, and its install's version.
    expect(row.others).toEqual([
      { path: c.older, source: "well-known", version: "0.30.0" },
    ]);
    // The interactive shell was asked once, though nothing was missing.
    await listRuntimes(d);
    expect(ranLines(c.asked)).toEqual(["-ilc"]);
  });

  it("(b) a quarantined copy is never run: 'quarantined, not run', and Set path refuses it", async () => {
    const c = await twoCopies();
    const looked: string[] = [];
    setQuarantineReader((file) => {
      looked.push(file);
      return file === c.newer;
    });
    const d = resolveAgentsDeps(c.r.deps);
    const row = (await listRuntimes(d)).find((x) => x.id === "codex")!;
    expect(row).toMatchObject({
      available: true,
      path: c.newer,
      quarantined: true,
    });
    expect(row.version).toBeUndefined();
    expect(looked).toContain(c.newer);
    expect(fs.existsSync(c.newerRan)).toBe(false);
    // Pinning it with a click runs its version command first: refused, not run.
    await expect(
      setRuntimePath(d, { id: "codex", scope: "global", bin: c.newer }),
    ).rejects.toThrow(/quarantined, not run/);
    expect(fs.existsSync(c.newerRan)).toBe(false);
    expect(c.r.runtimeBins.codex).toBeUndefined();
  });

  it("(b) the version commands never spawn a quarantined file (a marker it would write stays absent)", async () => {
    const r = await rig();
    const ran = path.join(r.dir, "q-ran");
    const q = write(path.join(r.dir, "q", "codex"), fakeCodex(ran, "1.0.0"));
    setQuarantineReader((file) => file === q);
    expect(await runtimeVersion(q, ["--version"], {})).toBeUndefined();
    expect(await versionOutput(q, ["--version"], {})).toEqual({
      ok: false,
      out: "",
      quarantined: true,
    });
    expect(fs.existsSync(ran)).toBe(false);
  });

  it("(c) only the chosen copy's version command runs", async () => {
    const c = await twoCopies();
    const d = resolveAgentsDeps(c.r.deps);
    const row = (await listRuntimes(d)).find((x) => x.id === "codex")!;
    expect(row.others?.map((o) => o.version)).toEqual(["0.30.0"]);
    expect(ranLines(c.newerRan)).toEqual(["--version"]);
    expect(fs.existsSync(c.olderRan)).toBe(false);
  });

  it("pinning another copy (agents.runtimes.codex.bin) makes it the one used; the search's copies stay listed", async () => {
    const c = await twoCopies();
    const d = resolveAgentsDeps(c.r.deps);
    const row = await setRuntimePath(d, {
      id: "codex",
      scope: "global",
      bin: c.older,
    });
    expect(c.r.runtimeBins.codex).toBe(c.older);
    expect(row).toMatchObject({
      path: c.older,
      source: "setting",
      version: "0.30.0",
    });
    expect(row.others).toEqual([
      { path: c.newer, source: "interactive-shell", version: undefined },
    ]);
  });
});

describe("issue 456: the copies' versions and the quarantine, read without running", () => {
  it("an npm install's version is its package.json's; the reader is asked once per file", async () => {
    const r = await rig();
    // Under nvm's node directory: node's version is never taken for its.
    const pkg = path.join(
      r.dir,
      "versions",
      "node",
      "v24.22.3",
      "lib",
      "node_modules",
      "@vendor",
      "cli",
    );
    write(
      path.join(pkg, "package.json"),
      JSON.stringify({ name: "@vendor/cli", version: "1.2.3" }),
      0o644,
    );
    const bin = write(path.join(pkg, "bin", "cli.js"), "#!/bin/sh\nexit 0\n");
    // Written a minute ago: an answer from a file written just now is asked
    // again (issue 1598, statSettled).
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(bin, old, old);
    expect(installVersion(bin)).toBe("1.2.3");
    let asked = 0;
    setQuarantineReader(() => {
      asked++;
      return false;
    });
    expect(isQuarantined(bin)).toBe(false);
    expect(isQuarantined(bin)).toBe(false);
    expect(asked).toBe(1);
    // A reader that throws reads as not quarantined.
    setQuarantineReader(() => {
      throw new Error("no xattr");
    });
    expect(isQuarantined(bin)).toBe(false);
  });
});

describe("issue 456: Settings › Agents › Runtimes shows the copies", () => {
  const row = {
    id: "codex",
    label: "Codex CLI",
    vendor: "OpenAI",
    available: true,
    version: "0.60.0",
    path: "/u/rc-bin/codex",
    source: "interactive-shell",
    setting: "agents.runtimes.codex.bin",
    others: [
      {
        path: "/opt/homebrew/bin/codex",
        source: "well-known",
        version: "0.30.0",
      },
      { path: "/usr/local/bin/codex", source: "PATH", quarantined: true },
    ],
  };

  it("the one used, then the others with their versions, each pinned with a click", () => {
    const h = runtimeRowHtml(row, "");
    expect(h).toContain("/u/rc-bin/codex");
    expect(h).toContain("✓ 0.60.0");
    expect(h).toContain("detected · interactive shell");
    expect(h).toContain("Also found:");
    expect(h).toMatch(
      /data-copy="\/opt\/homebrew\/bin\/codex".*0\.30\.0.*detected · install directory.*data-pin-path="codex" data-bin="\/opt\/homebrew\/bin\/codex"[^>]*>Use this</,
    );
    expect(h).toMatch(
      /data-copy="\/usr\/local\/bin\/codex".*version unknown.*quarantined, not run.*data-bin="\/usr\/local\/bin\/codex"/,
    );
    // The one used is not offered again.
    expect(h).not.toContain('data-bin="/u/rc-bin/codex"');
  });

  it("a quarantined CLI in use says so instead of a checked version; one copy lists nothing more", () => {
    const h = runtimeRowHtml(
      { ...row, version: undefined, quarantined: true, others: undefined },
      "",
    );
    expect(h).toContain('data-quarantined="true">quarantined, not run<');
    expect(h).not.toContain("✓");
    expect(h).not.toContain("Also found:");
  });
});

describe("issue 456: agents doctor lists the copies", () => {
  it("names the one used, then each other copy with its version and source", () => {
    const lines = doctorLines(
      {
        id: "codex",
        available: true,
        version: "0.60.0",
        path: "/u/rc-bin/codex",
        source: "interactive-shell",
        searched: ["/u/rc-bin"],
        setting: "agents.runtimes.codex.bin",
        others: [
          {
            path: "/opt/homebrew/bin/codex",
            source: "well-known",
            version: "0.30.0",
          },
          { path: "/usr/local/bin/codex", source: "PATH", quarantined: true },
        ],
        resume: false,
        default: false,
        models: [],
      },
      "acme",
      "/u/user.yml",
    );
    expect(lines).toEqual(
      expect.arrayContaining([
        "  path      /u/rc-bin/codex (interactive shell PATH)",
        "  version   0.60.0",
        "  also      /opt/homebrew/bin/codex (0.30.0, install directory)",
        "            /usr/local/bin/codex (version unknown, PATH, quarantined, not run)",
        "            to use one, set agents.runtimes.codex.bin to its path",
      ]),
    );
  });
});
