/**
 * Issue 1038: `gate run -- <command>` ran the command with the CLI's own
 * environment, and the launcher had set DEN_ROOT, DEN_ENGINE_ROOT and
 * DEN_INVOKE_CWD there for the install the CLI belongs to. So a test run
 * in some other checkout saw that install (issue 1036: every test server
 * restarted its terminal host). Now the first launcher records what the
 * caller had, and gate run gives the command those values back: as if the
 * gate weren't there.
 *
 * The real bin/den, in throwaway distributions, runs `printenv` under a
 * cpu slot. Its subject: bin/den's record, src/shared/caller-env.ts and
 * the spawn in src/ui/cli/gate-command.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const ENGINE = path.resolve(__dirname, "../../..");
const MARKERS = ["DEN_ROOT", "DEN_ENGINE_ROOT", "DEN_INVOKE_CWD"];
let tmp = "";

function write(file: string, content: string, mode?: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, mode ? { mode } : undefined);
}

/**
 * A distribution at `dir`, with this Den linked in as its engine (`own`),
 * or one that installs some other Den.
 */
function distribution(dir: string, own = true): string {
  write(path.join(dir, "den.yml"), "product:\n  name: den\n");
  write(path.join(dir, "config", "den.yml"), "environments: [local]\n");
  if (!own) return dir;
  const link = path.join(dir, "node_modules", "@monster-orange", "den");
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync(ENGINE, link);
  // Its launcher, as the distribution template has it.
  write(
    path.join(dir, "bin", "dist"),
    '#!/bin/sh\nDEN_ROOT="$(cd "$(dirname "$0")/.." && pwd)"\n' +
      'export DEN_ROOT; exec "$DEN_ROOT/node_modules/@monster-orange/den/bin/den" "$@"\n',
    0o755,
  );
  return dir;
}

/** The command's own environment, under `gate run`, as a map. */
function childEnv(
  launcher: string,
  cwd: string,
  extra: NodeJS.ProcessEnv = {},
): Record<string, string> {
  const gates = fs.mkdtempSync(path.join(tmp, "gates-"));
  const env: NodeJS.ProcessEnv = {
    HOME: path.join(tmp, "home"),
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    DEN_HOME: path.join(tmp, "home", ".den"),
    DEN_GATE_DIR: gates,
    FORCE_COLOR: "0",
    NO_COLOR: "1",
    ...extra,
  };
  const r = spawnSync(
    launcher,
    ["gate", "run", "--kind", "cpu", "--estimate", "1m", "--", "printenv"],
    { cwd, encoding: "utf-8", input: "", env, timeout: 60_000 },
  );
  if (r.status !== 0)
    throw new Error(`gate run exited ${r.status}: ${r.stderr}`);
  const out: Record<string, string> = {};
  for (const line of r.stdout.split("\n")) {
    const i = line.indexOf("=");
    if (i > 0 && /^[A-Z_][A-Z0-9_]*$/.test(line.slice(0, i)))
      out[line.slice(0, i)] = line.slice(i + 1);
  }
  return out;
}

const markersOf = (e: Record<string, string>) =>
  Object.fromEntries(MARKERS.filter((m) => m in e).map((m) => [m, e[m]]));

beforeAll(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-1038-")));
});

afterAll(() => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

describe("gate run gives the command the caller's environment (issue 1038)", () => {
  it("a distribution's launcher: the command sees none of its install's markers", () => {
    const dist = distribution(path.join(tmp, "dist-a"));
    const work = path.join(tmp, "work");
    fs.mkdirSync(work, { recursive: true });
    const e = childEnv(path.join(dist, "bin", "dist"), work);
    expect(markersOf(e)).toEqual({});
    expect(e.DEN_CALLER_ENV_SET).toBeUndefined();
  }, 90_000);

  it("the caller's own DEN_ROOT (another distribution) reaches the command", () => {
    const mine = distribution(path.join(tmp, "dist-b"), false);
    const e = childEnv(path.join(ENGINE, "bin", "den"), tmp, {
      DEN_ROOT: mine,
    });
    expect(markersOf(e)).toEqual({ DEN_ROOT: mine });
  }, 90_000);

  it("the caller's own DEN_INVOKE_CWD reaches the command; the engine's root doesn't", () => {
    const dist = distribution(path.join(tmp, "dist-c"));
    const e = childEnv(path.join(dist, "bin", "dist"), tmp, {
      DEN_INVOKE_CWD: "/somewhere/the/caller/was",
    });
    expect(markersOf(e)).toEqual({
      DEN_INVOKE_CWD: "/somewhere/the/caller/was",
    });
  }, 90_000);
});
