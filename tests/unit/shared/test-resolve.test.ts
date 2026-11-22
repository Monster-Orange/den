/**
 * Issue 1073: a test install's name map for Den's own address checks,
 * `<PREFIX>_TEST_RESOLVE="name=ip,name=ip"`. Parsed strictly; consulted
 * only while the install is a test install; never a config key.
 */
import { describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  parseTestResolve,
  readTestResolveState,
  testResolveDoctorLine,
  testResolver,
  writeTestResolveState,
} from "../../../src/shared/test-resolve.js";

describe("parseTestResolve", () => {
  it("reads name=ip pairs, names in lower case", () => {
    expect(
      parseTestResolve("Den.Bed.test=127.0.0.1, other.bed.test=::1"),
    ).toEqual({
      ok: true,
      map: new Map([
        ["den.bed.test", "127.0.0.1"],
        ["other.bed.test", "::1"],
      ]),
    });
  });

  it("unset or empty: no map", () => {
    expect(parseTestResolve(undefined)).toEqual({ ok: true, map: new Map() });
    expect(parseTestResolve("")).toEqual({ ok: true, map: new Map() });
  });

  it("refuses a pair that isn't name=ip, naming it, and keeps no map", () => {
    for (const bad of [
      "den.bed.test",
      "den.bed.test=not-an-ip",
      "=127.0.0.1",
      "den bed=127.0.0.1",
      "127.0.0.1=127.0.0.1",
    ]) {
      const r = parseTestResolve(bad);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain(bad.split(",")[0]!.trim());
    }
  });
});

describe("testResolver", () => {
  const map = new Map([["den.bed.test", "127.0.0.1"]]);

  it("on a test install, a mapped name resolves to its address", () => {
    const r = testResolver(map, () => true);
    expect(r("den.bed.test")).toBe("127.0.0.1");
    expect(r("DEN.BED.TEST.")).toBe("127.0.0.1");
  });

  it("a name the map doesn't hold is left to DNS (null)", () => {
    expect(testResolver(map, () => true)("other.example")).toBeNull();
  });

  it("not a test install (now): the map is ignored", () => {
    let testInstall = true;
    const r = testResolver(map, () => testInstall);
    expect(r("den.bed.test")).toBe("127.0.0.1");
    testInstall = false;
    expect(r("den.bed.test")).toBeNull();
  });
});

describe("doctor's line", () => {
  it("names the ignored setting, and why", () => {
    expect(
      testResolveDoctorLine({
        state: "ignored",
        env: "DEN_TEST_RESOLVE",
        why: "this install wasn't started as a test install",
      }),
    ).toBe(
      "  test names  ✗  DEN_TEST_RESOLVE is ignored: this install wasn't started as a test install. Den's address checks use this machine's DNS.",
    );
  });

  it("says which names a test install maps; nothing when unset", () => {
    expect(
      testResolveDoctorLine({ state: "used", names: ["den.bed.test"] }),
    ).toContain("den.bed.test");
    expect(testResolveDoctorLine(null)).toBeNull();
  });

  it("the server's decision round-trips through the state folder", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-1073-"));
    writeTestResolveState(dir, { state: "used", names: ["den.bed.test"] });
    expect(readTestResolveState(dir)).toEqual({
      state: "used",
      names: ["den.bed.test"],
    });
    writeTestResolveState(dir, null);
    expect(readTestResolveState(dir)).toBeNull();
  });
});
