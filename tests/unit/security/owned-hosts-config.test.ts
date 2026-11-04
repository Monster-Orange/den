/**
 * The security pillar's owned-host allowlist is config-driven:
 * config/den.yml `security.owned_hosts`, defaulting to the local edge
 * domains only. fs is mocked — no real config is read.
 */

import { afterEach, describe, expect, it, jest } from "@jest/globals";

jest.mock("fs");

import * as fs from "fs";
import {
  DEFAULT_SECURITY_OWNED_HOSTS,
  readDenConfig,
  readSecurityOwnedHosts,
} from "../../../src/shared/den-config.js";

const mockReadFileSync = fs.readFileSync as jest.MockedFunction<
  typeof fs.readFileSync
>;

function mockDenYml(contents: string | null) {
  mockReadFileSync.mockImplementation((filePath: unknown): unknown => {
    const p = String(filePath);
    if (contents !== null && p.endsWith("config/den.yml")) return contents;
    const err = new Error(`ENOENT: ${p}`) as NodeJS.ErrnoException;
    err.code = "ENOENT";
    throw err;
  });
}

afterEach(() => {
  jest.resetAllMocks();
});

describe("readSecurityOwnedHosts", () => {
  it("owns nothing by default", () => {
    expect([...DEFAULT_SECURITY_OWNED_HOSTS]).toEqual([]);
    mockDenYml(null);
    expect(readSecurityOwnedHosts()).toEqual([...DEFAULT_SECURITY_OWNED_HOSTS]);
    mockDenYml("environments: [local]\n");
    expect(readSecurityOwnedHosts()).toEqual([...DEFAULT_SECURITY_OWNED_HOSTS]);
  });

  it("reads security.owned_hosts from config/den.yml, trimmed and lowercased", () => {
    mockDenYml(
      [
        "environments: [local]",
        "security:",
        "  owned_hosts:",
        "    - ' Scan.Example.Test '",
        "    - ''",
        "    - 42",
      ].join("\n"),
    );
    expect(readDenConfig().security?.owned_hosts).toHaveLength(3);
    expect(readSecurityOwnedHosts()).toEqual(["scan.example.test"]);
  });

  it("an explicit empty list means nothing is owned", () => {
    mockDenYml("environments: [local]\nsecurity:\n  owned_hosts: []\n");
    expect(readSecurityOwnedHosts()).toEqual([]);
  });

  it("a malformed value falls back to the defaults", () => {
    mockDenYml(
      "environments: [local]\nsecurity:\n  owned_hosts: example.com\n",
    );
    expect(readSecurityOwnedHosts()).toEqual([...DEFAULT_SECURITY_OWNED_HOSTS]);
  });
});
