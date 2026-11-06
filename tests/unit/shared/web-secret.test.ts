/**
 * SEC-1a: web.secret (32 random bytes, 0600 in the state dir) and the
 * person token derived from it. No secret or token is ever printed: the
 * assertions compare lengths, modes and hashes.
 */
import { afterAll, describe, expect, it } from "@jest/globals";
import { createHash } from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  cliAuthHeaders,
  ensureWebSecret,
  personToken,
  readWebSecret,
  verifyPersonToken,
  webSecretPath,
  WebSecretStore,
} from "../../../src/shared/web-secret.js";
import { cmdWebToken } from "../../../src/ui/cli/web-command.js";

const tmp = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), "den-secret-")),
);
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
let n = 0;
const fresh = () => path.join(tmp, `state-${n++}`);
const hash = (s: string | Buffer) =>
  createHash("sha256").update(s).digest("hex");

describe("web.secret", () => {
  it("is 32 bytes, mode 0600, in a 0700 state dir it creates", () => {
    const dir = fresh();
    const s = ensureWebSecret(dir);
    expect(s.length).toBe(32);
    expect(fs.statSync(webSecretPath(dir)).mode & 0o777).toBe(0o600);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    // The same secret on every later read.
    expect(hash(ensureWebSecret(dir))).toBe(hash(s));
    expect(hash(readWebSecret(dir)!)).toBe(hash(s));
  });

  it("tightens a file that is looser than 0600", () => {
    const dir = fresh();
    ensureWebSecret(dir);
    fs.chmodSync(webSecretPath(dir), 0o644);
    ensureWebSecret(dir);
    expect(fs.statSync(webSecretPath(dir)).mode & 0o777).toBe(0o600);
  });

  it("replaces a malformed file; a missing one reads as null", () => {
    const dir = fresh();
    expect(readWebSecret(dir)).toBeNull();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(webSecretPath(dir), "short", { mode: 0o600 });
    expect(readWebSecret(dir)).toBeNull();
    expect(ensureWebSecret(dir).length).toBe(32);
  });
});

describe("the person token", () => {
  it("is den_pt_<b64url HMAC>, per secret and per user, and verifies", () => {
    const a = ensureWebSecret(fresh());
    const b = ensureWebSecret(fresh());
    const t = personToken(a, "someone");
    expect(t).toMatch(/^den_pt_[A-Za-z0-9_-]{43}$/);
    expect(hash(personToken(b, "someone"))).not.toBe(hash(t));
    expect(hash(personToken(a, "other"))).not.toBe(hash(t));
    expect(verifyPersonToken(t, a, "someone")).toBe("person:someone");
    expect(verifyPersonToken(t, b, "someone")).toBeNull();
    expect(verifyPersonToken(t.slice(0, -1), a, "someone")).toBeNull();
    expect(verifyPersonToken("", a, "someone")).toBeNull();
  });

  it("cliAuthHeaders sends it; with no secret, nothing", () => {
    const dir = fresh();
    expect(cliAuthHeaders(dir)).toEqual({});
    const s = ensureWebSecret(dir);
    const h = cliAuthHeaders(dir);
    expect(hash(h.Authorization)).toBe(hash(`Bearer ${personToken(s)}`));
  });

  it("the server's store sees a rotated secret", () => {
    const dir = fresh();
    const store = new WebSecretStore(() => dir);
    store.ensure();
    const first = hash(store.current()!);
    fs.unlinkSync(webSecretPath(dir));
    expect(store.current()).toBeNull();
    ensureWebSecret(dir);
    expect(hash(store.current()!)).not.toBe(first);
  });
});

describe("<cli> web token --print", () => {
  it("prints the token alone on stdout, a one-line note on stderr", () => {
    const dir = fresh();
    const out: string[] = [];
    const err: string[] = [];
    const code = cmdWebToken(["--print"], {
      out: (s) => out.push(s),
      err: (s) => err.push(s),
      stateDir: dir,
    });
    expect(code).toBe(0);
    // Created on first need, and the token is the one the server derives.
    const s = readWebSecret(dir)!;
    expect(out.join("")).toMatch(/^den_pt_[A-Za-z0-9_-]{43}\n$/);
    expect(hash(out.join("").trim())).toBe(hash(personToken(s)));
    expect(err.join("").trim().split("\n")).toHaveLength(1);
    expect(err.join("")).toMatch(/grants your access/);
    expect(err.join("")).not.toContain(out.join("").trim());
  });

  it("without --print it prints usage and no token", () => {
    const out: string[] = [];
    const err: string[] = [];
    const code = cmdWebToken([], {
      out: (s) => out.push(s),
      err: (s) => err.push(s),
      stateDir: fresh(),
    });
    expect(code).toBe(2);
    expect(out).toEqual([]);
    expect(err.join("")).toMatch(/web token --print/);
  });
});
