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
 * `homebrew/bin` is both a well-known dir and on the login shell's PATH.
 * The newer one is first on the interactive shell's PATH only (an rc
 * file's PATH).
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
      `case "$1" in -ilc) P="${rcBin}:${brewBin}:/usr/bin";; *) P="${brewBin}:/usr/bin";; esac`,
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
