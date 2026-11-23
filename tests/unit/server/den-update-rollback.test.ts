/**
 * Issue 125: a rollback that fails is reported as failed, never as a success,
 * and the update state never stays stuck at "installing". Every command is a
 * stub; real files in a temp distribution.
 */
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  readUpdateState,
  updateDen,
  updateDir,
  type Ran,
  type UpdateDeps,
} from "../../../src/ui/server/den-update.js";

const NAME = "@example/den";
const DOCTOR_OK = JSON.stringify({ checks: [] });
let tmp: string;
let root: string;
let engine: string;
let stateDir: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "den-update-rb-"));
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

function rig(answers: (argv: string[]) => Ran | Promise<Ran>) {
  const ran: string[] = [];
  let restarts = 0;
  const deps: UpdateDeps = {
    root,
    engine,
    stateDir,
    pkg: { name: NAME, version: "1.0.0" },
    npmView: async (spec) => spec.split("@").pop()!,
    npm: ["npm"],
    cli: ["den"],
    run: async (argv) => {
      ran.push(argv.join(" "));
      return answers(argv);
    },
    watch: () => 4242,
    note: (reason) => ({
      path: path.join(stateDir, "restart.json"),
      marker: { reason },
    }),
    restart: () => void restarts++,
    port: 7000,
    pid: 1111,
    waitMs: 1000,
  };
  return { deps, ran, restarts: () => restarts };
}

const isRecovery = (argv: string[]) =>
  argv[1] === "install" && !argv.includes("--save-exact");

describe("a failed rollback is reported honestly (issue 125)", () => {
  it("the recovery install fails too: rollback_failed, with the reason", async () => {
    const r = rig((argv) =>
      argv.includes("--save-exact")
        ? { code: 1, out: "npm ERR! network down" }
        : isRecovery(argv)
          ? { code: 1, out: "npm ERR! network still down" }
          : { code: 0, out: DOCTOR_OK },
    );
    const res = await updateDen("1.2.0", r.deps);
    expect(res.ok).toBe(false);
    const error = !res.ok ? res.error : "";
    expect(error).not.toMatch(/The pin is back/);
    expect(error).toMatch(
      /npm install of 1\.0\.0 failed \(exit 1\): npm ERR! network still down/,
    );
    expect(error).toMatch(/rollback failed/i);
    // Issue 125: the hand-fix's parts, apart from npm's long reasons, so
    // the bell can lead with them.
    expect(!res.ok && res.rollbackFailed).toEqual({
      from: "1.0.0",
      root: r.deps.root,
      why: expect.stringMatching(
        /npm install of 1\.2\.0 failed .*; npm install of 1\.0\.0 failed/,
      ),
    });
    const s = readUpdateState(stateDir);
    expect(s?.state).toBe("rollback_failed");
    expect(s?.why).toMatch(/npm install of 1\.2\.0 failed \(exit 1\)/);
    expect(s?.why).toMatch(/npm install of 1\.0\.0 failed \(exit 1\)/);
    expect(r.restarts()).toBe(0);
  });

  it("the doctor path checks the recovery install too", async () => {
    const r = rig((argv) =>
      argv.includes("doctor")
        ? { code: 1, out: "SyntaxError: bad" }
        : isRecovery(argv)
          ? { code: 1, out: "npm ERR! EACCES" }
          : { code: 0, out: "" },
    );
    const res = await updateDen("1.1.0", r.deps);
    expect(!res.ok && res.error).toMatch(/rollback failed/i);
    expect(readUpdateState(stateDir)).toMatchObject({
      state: "rollback_failed",
      why: expect.stringMatching(/npm ERR! EACCES/),
    });
  });

  it("a pin file that can't be copied back: rollback_failed, not stuck at installing", async () => {
    const r = rig((argv) => {
      if (argv.includes("--save-exact")) {
        // The saved pin is gone by the time the rollback copies it back.
        fs.rmSync(path.join(updateDir(stateDir), "package.json.1.0.0"));
        return { code: 1, out: "npm ERR! 404" };
      }
      return { code: 0, out: "" };
    });
    const res = await updateDen("1.2.0", r.deps);
    expect(res.ok).toBe(false);
    expect(!res.ok && res.error).toMatch(/rollback failed/i);
    const s = readUpdateState(stateDir);
    expect(s?.state).toBe("rollback_failed");
    expect(s?.why).toMatch(/could not put the pin files back: .*ENOENT/);
    // No recovery install runs on a half-restored pin.
    expect(
      r.ran.filter((a) => a === "npm install --no-audit --no-fund"),
    ).toEqual([]);
  });

  it("an install step that throws is rolled back, never left at installing", async () => {
    const r = rig((argv) => {
      if (argv.includes("--save-exact")) throw new Error("spawn npm ENOENT");
      return { code: 0, out: "" };
    });
    const res = await updateDen("1.2.0", r.deps);
    expect(res.ok).toBe(false);
    expect(!res.ok && res.error).toMatch(/spawn npm ENOENT/);
    expect(readUpdateState(stateDir)).toMatchObject({
      state: "rolled_back",
      why: expect.stringMatching(/spawn npm ENOENT/),
    });
  });

  it("a recovery install that succeeds is still rolled_back with the pin back", async () => {
    const r = rig((argv) =>
      argv.includes("--save-exact")
        ? { code: 1, out: "npm ERR! 404" }
        : { code: 0, out: "" },
    );
    const res = await updateDen("1.2.0", r.deps);
    expect(!res.ok && res.error).toMatch(/The pin is back on 1\.0\.0\.$/);
    expect(readUpdateState(stateDir)?.state).toBe("rolled_back");
  });
});
