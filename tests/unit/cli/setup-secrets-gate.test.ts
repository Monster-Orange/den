/**
 * `scripts/setup-secrets.ts --gate` (the up/restart secrets preflight), with
 * a fake `doppler` on PATH: a backend that is signed in but has no default
 * scope must not read as "not ready" (secret_env refs carry their own).
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const root = path.resolve(__dirname, "../../..");
let tmp: string;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "den-gate-"));
  fs.mkdirSync(path.join(tmp, "bin"));
  fs.mkdirSync(path.join(tmp, "dist"));
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

function gate(signedIn: boolean) {
  const fake = path.join(tmp, "bin", "doppler");
  fs.writeFileSync(
    fake,
    `#!/bin/sh\ncase "$1" in me) exit ${signedIn ? 0 : 1};; *) exit 1;; esac\n`,
  );
  fs.chmodSync(fake, 0o755);
  const r = spawnSync(
    path.join(root, "node_modules", ".bin", "tsx"),
    [path.join(root, "scripts", "setup-secrets.ts"), "--gate"],
    {
      cwd: path.join(tmp, "dist"),
      encoding: "utf-8",
      env: {
        ...process.env,
        PATH: `${path.join(tmp, "bin")}:${process.env.PATH}`,
        DEN_SECRETS_PROVIDER: "doppler",
        DEN_ENGINE_ROOT: root,
      },
    },
  );
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

describe("secrets gate", () => {
  it("signed in without a default scope: says so, without 'not ready'", () => {
    const r = gate(true);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/signed in, no default scope set/);
    expect(r.out).toMatch(/secret_env refs still resolve/);
    expect(r.out).not.toMatch(/not ready/);
  }, 60_000);

  it("not signed in: still warns that the backend is not ready", () => {
    const r = gate(false);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/not ready — continuing/);
  }, 60_000);
});
