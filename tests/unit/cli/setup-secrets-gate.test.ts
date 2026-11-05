/**
 * `scripts/setup-secrets.ts --gate` (the up / web secrets preflight), with a
 * fake `doppler` that records every call.
 *
 * - Nothing required (no `secrets.required`): the gate passes silently,
 *   whatever the provider, and never calls the backend (0.3.0-dev.23).
 * - `secrets.required: true`: the backend must be ready; signed out fails
 *   with the remediation, and a CLI that is not on PATH fails with
 *   detect()'s reason instead of a spawn error.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const root = path.resolve(__dirname, "../../..");
let tmp: string;
let calls: string;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "den-gate-"));
  fs.mkdirSync(path.join(tmp, "bin"));
  fs.mkdirSync(path.join(tmp, "dist", "config"), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, "dist", "den.yml"),
    "product:\n  name: den\n",
  );
  calls = path.join(tmp, "doppler-calls");
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** PATH without any real doppler; with the fake one when `fake` is set. */
function pathWithout(fake: boolean): string {
  const dirs = (process.env.PATH ?? "")
    .split(path.delimiter)
    .filter((d) => d && !fs.existsSync(path.join(d, "doppler")));
  return [...(fake ? [path.join(tmp, "bin")] : []), ...dirs].join(
    path.delimiter,
  );
}

function gate(opts: {
  signedIn?: boolean;
  required?: boolean;
  onPath?: boolean;
  provider?: string;
}) {
  fs.rmSync(calls, { force: true });
  const fake = path.join(tmp, "bin", "doppler");
  fs.writeFileSync(
    fake,
    `#!/bin/sh\necho "$1" >> ${calls}\ncase "$1" in me|secrets) exit ${opts.signedIn ? 0 : 1};; *) exit 1;; esac\n`,
  );
  fs.chmodSync(fake, 0o755);
  fs.writeFileSync(
    path.join(tmp, "dist", "config", "den.yml"),
    `secrets:\n  provider: ${opts.provider ?? "doppler"}\n${opts.required ? "  required: true\n" : ""}`,
  );
  const r = spawnSync(
    path.join(root, "node_modules", ".bin", "tsx"),
    [path.join(root, "scripts", "setup-secrets.ts"), "--gate"],
    {
      cwd: path.join(tmp, "dist"),
      encoding: "utf-8",
      env: {
        ...process.env,
        PATH: pathWithout(opts.onPath !== false),
        DEN_SECRETS_PROVIDER: "",
        DEN_ROOT: path.join(tmp, "dist"),
        DEN_ENGINE_ROOT: root,
      },
    },
  );
  return {
    code: r.status,
    out: `${r.stdout}${r.stderr}`,
    called: fs.existsSync(calls),
  };
}

describe("secrets gate", () => {
  it.each(["doppler", "1password", "env", "none"])(
    "nothing required (%s): passes silently and asks no backend",
    (provider) => {
      const r = gate({ provider, signedIn: false });
      expect(r.code).toBe(0);
      expect(r.out).toBe("");
      expect(r.called).toBe(false);
    },
    60_000,
  );

  it("required and signed in: passes", () => {
    const r = gate({ required: true, signedIn: true });
    expect(r.code).toBe(0);
  }, 60_000);

  it("required and signed out: fails with the remediation", () => {
    const r = gate({ required: true, signedIn: false });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/doppler login/);
  }, 60_000);

  it("required, doppler not on PATH: fails with detect()'s reason", () => {
    const r = gate({ required: true, onPath: false });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/not available: .*\(doppler\) is not on PATH/);
    expect(r.called).toBe(false);
  }, 60_000);
});
