/**
 * SRV-1b: den_update's run (den-update.ts), with every command faked: no
 * npm, no Den CLI, no restart. Real files in a temp distribution.
 */
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  readUpdateState,
  updateDen,
  updateDir,
  updateProblem,
  type Ran,
  type UpdateDeps,
} from "../../../src/ui/server/den-update.js";

const NAME = "@example/den";
let tmp: string;
let root: string;
let engine: string;
let stateDir: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "den-update-"));
  root = path.join(tmp, "dist");
  engine = path.join(root, "node_modules", "@example", "den");
  stateDir = path.join(tmp, "state");
  fs.mkdirSync(path.join(engine, "src/ui/server"), { recursive: true });
  fs.writeFileSync(
    path.join(engine, "src/ui/server/update-watch.mjs"),
    "// the watch\n",
  );
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ dependencies: { [NAME]: "1.0.0" } }),
  );
  fs.writeFileSync(path.join(root, "package-lock.json"), '{"lock":"1.0.0"}');
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

const DOCTOR_OK = JSON.stringify({
  checks: [
    { id: "edge", status: "ok", detail: "fine" },
    { id: "hub", status: "warn", detail: "not connected" },
  ],
});

function rig(
  over: Partial<UpdateDeps> = {},
  answers: (argv: string[]) => Ran = () => ({ code: 0, out: DOCTOR_OK }),
) {
  const ran: { argv: string[]; cwd: string }[] = [];
  const watched: { script: string; plan: string }[] = [];
  const notes: string[] = [];
  let restarts = 0;
  const deps: UpdateDeps = {
    root,
    engine,
    stateDir,
    pkg: { name: NAME, version: "1.0.0" },
    npmView: async (spec) =>
      spec.endsWith("@latest") ? "1.1.0" : spec.endsWith("@9.9.9") ? null : spec.split("@").pop()!,
    npm: ["npm"],
    cli: ["den"],
    run: async (argv, cwd) => {
      ran.push({ argv, cwd });
      return answers(argv);
    },
    watch: (script, plan) => {
      watched.push({ script, plan });
      return 4242;
    },
    note: (reason) => {
      notes.push(reason);
      return { path: path.join(stateDir, "restart.json"), marker: { reason } };
    },
    restart: () => void restarts++,
    port: 7000,
    pid: 1111,
    waitMs: 180_000,
    ...over,
  };
  return { deps, ran, watched, notes, restarts: () => restarts };
}

describe("updateDen (SRV-1b)", () => {
  it("installs the exact version, runs the new doctor, starts the watch, then restarts", async () => {
    const r = rig();
    const res = await updateDen("latest", r.deps);
    expect(res).toEqual({
      ok: true,
      from: "1.0.0",
      to: "1.1.0",
      restarting: true,
      doctor: ["warn: hub: not connected"],
    });
    expect(r.ran.map((x) => x.argv.join(" "))).toEqual([
      `npm install --save-exact --no-audit --no-fund ${NAME}@1.1.0`,
      "den doctor --json",
    ]);
    expect(r.ran.every((x) => x.cwd === root)).toBe(true);
    // The watch runs from the state dir (npm is replacing the engine).
    const dir = updateDir(stateDir);
    expect(r.watched).toEqual([
      { script: path.join(dir, "watch.mjs"), plan: path.join(dir, "plan.json") },
    ]);
    expect(fs.readFileSync(path.join(dir, "watch.mjs"), "utf8")).toBe(
      "// the watch\n",
    );
    const plan = JSON.parse(fs.readFileSync(path.join(dir, "plan.json"), "utf8"));
    expect(plan).toMatchObject({
      port: 7000,
      from: "1.0.0",
      to: "1.1.0",
      fromPid: 1111,
      waitMs: 180_000,
      root,
      npm: ["npm", "install", "--no-audit", "--no-fund"],
      restart: ["den", "web", "restart", "--no-open", "--port", "7000"],
    });
    expect(plan.backups.map((b: { path: string }) => path.basename(b.path))).toEqual([
      "package.json",
      "package-lock.json",
    ]);
    expect((fs.statSync(path.join(dir, "plan.json")).mode & 0o777).toString(8)).toBe("600");
    expect(r.notes).toEqual(["update Den 1.0.0 → 1.1.0"]);
    expect(r.restarts()).toBe(1);
    expect(readUpdateState(stateDir)).toMatchObject({
      state: "watching",
      from: "1.0.0",
      to: "1.1.0",
    });
  });

  it("an install that fails puts the pin back, installs the old one, and says so", async () => {
    const r = rig({}, (argv) =>
      argv.includes("--save-exact")
        ? (fs.writeFileSync(path.join(root, "package.json"), "{\"broken\":1}"),
          { code: 1, out: "npm ERR! 404 nope" })
        : { code: 0, out: "" },
    );
    const res = await updateDen("1.2.0", r.deps);
    expect(res.ok).toBe(false);
    expect(!res.ok && res.error).toMatch(
      /^npm install of 1\.2\.0 failed \(exit 1\): npm ERR! 404 nope\. The pin is back on 1\.0\.0\.$/,
    );
    expect(JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"))).toEqual({
      dependencies: { [NAME]: "1.0.0" },
    });
    expect(r.ran.at(-1)!.argv).toEqual(["npm", "install", "--no-audit", "--no-fund"]);
    expect(r.watched).toEqual([]);
    expect(r.restarts()).toBe(0);
    expect(readUpdateState(stateDir)?.state).toBe("rolled_back");
  });

  it("a new Den whose doctor can't run is rolled back before any restart", async () => {
    const r = rig({}, (argv) =>
      argv.includes("doctor") ? { code: 1, out: "SyntaxError: bad" } : { code: 0, out: "" },
    );
    const res = await updateDen("1.1.0", r.deps);
    expect(!res.ok && res.error).toMatch(/doctor didn't run \(exit 1\): SyntaxError: bad\. The pin is back on 1\.0\.0\./);
    expect(r.restarts()).toBe(0);
    expect(readUpdateState(stateDir)?.state).toBe("rolled_back");
  });

  it("refuses: a bad version, one npm hasn't, the same one, and one in flight", async () => {
    const r = rig();
    expect(await updateDen("1.0", r.deps)).toEqual({
      ok: false,
      error: "version: latest, or one like 0.4.44",
    });
    expect(await updateDen("9.9.9", r.deps)).toMatchObject({
      ok: false,
      error: `npm has no ${NAME}@9.9.9`,
    });
    expect(await updateDen("1.0.0", r.deps)).toMatchObject({
      ok: false,
      error: "Den is on 1.0.0 already",
    });
    expect(r.ran).toEqual([]);
    await updateDen("1.1.0", r.deps);
    const again = await updateDen("1.2.0", r.deps);
    expect(!again.ok && again.error).toMatch(/^an update to 1\.1\.0 is already watching/);
  });

  it("a Den not in the distribution's own node_modules is updated with git, not here", () => {
    const elsewhere = path.join(tmp, "checkout");
    fs.mkdirSync(elsewhere);
    expect(updateProblem(root, elsewhere, NAME)).toMatch(
      /not from the distribution's own node_modules .*: update it with git there, then den_restart_server/,
    );
    expect(updateProblem(root, engine, NAME)).toBeNull();
  });
});
