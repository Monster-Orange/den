/**
 * Issue 1407 (Vision's ruling): doctor shows a "test install" row on any
 * install holding the creation claim (test-install.created), sealed,
 * pending or not verifying, so the claim is never hidden. An install with
 * no claim gets no row. Temp folders only; no secret is printed.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { testInstallClaimLines } from "../../../src/ui/cli/test-person.js";
import {
  CREATION_PENDING,
  creationRecordPath,
  writeCreationRecord,
} from "../../../src/shared/test-operator.js";
import { ensureWebSecret } from "../../../src/shared/web/web-secret.js";

const dirs: string[] = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "den-1407d-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});

describe("doctor's test install row", () => {
  it("no claim: no row", () => {
    const d = tmp();
    ensureWebSecret(d);
    const r = testInstallClaimLines("Den", d);
    expect(r.check).toBeNull();
    expect(r.lines).toEqual([]);
  });

  it("a sealed claim: a row, state sealed", () => {
    const d = tmp();
    writeCreationRecord(d, ensureWebSecret(d));
    const r = testInstallClaimLines("Den", d);
    expect(r.check).toMatchObject({
      id: "test_install",
      status: "ok",
      state: "sealed",
    });
    expect(r.lines.length).toBeGreaterThan(0);
  });

  it("a pending claim: a row, state pending", () => {
    const d = tmp();
    fs.writeFileSync(creationRecordPath(d), `${CREATION_PENDING}\n`, {
      mode: 0o600,
    });
    expect(testInstallClaimLines("Den", d).check).toMatchObject({
      id: "test_install",
      state: "pending",
    });
  });

  it("another install's record copied in: still a row, state unverified, a warning", () => {
    const other = tmp();
    writeCreationRecord(other, ensureWebSecret(other));
    const d = tmp();
    ensureWebSecret(d);
    fs.copyFileSync(creationRecordPath(other), creationRecordPath(d));
    expect(testInstallClaimLines("Den", d).check).toMatchObject({
      id: "test_install",
      status: "warn",
      state: "unverified",
    });
  });

  it("the row never prints the record or the secret", () => {
    const d = tmp();
    writeCreationRecord(d, ensureWebSecret(d));
    const rec = fs.readFileSync(creationRecordPath(d), "utf-8").trim();
    const out = testInstallClaimLines("Den", d).lines.join("\n");
    expect(out.includes(rec)).toBe(false);
    expect(out.includes(rec.split(".").pop()!)).toBe(false);
  });
});
