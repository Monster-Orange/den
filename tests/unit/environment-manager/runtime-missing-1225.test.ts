/**
 * Issue 1225: doctor says so when a recorded service lists containers but
 * this machine has no container runtime on PATH: a restart can't bring it
 * back until one is installed. Invented names only.
 */
import { describe, expect, it } from "@jest/globals";
import { runtimeMissingDoctorLine } from "../../../src/shared/environment-manager/restore-on-boot.js";

const rec = (address: string, containers?: string[]) => ({
  address,
  containers,
});

describe("issue 1225: doctor when a service needs a container runtime", () => {
  it("no runtime, one record lists containers: names it", () => {
    expect(
      runtimeMissingDoctorLine({
        runtime: false,
        records: [rec("kiosk/web"), rec("ledger/db", ["ledger-db-1"])],
      }),
    ).toBe(
      "No container runtime (docker) on PATH, but 1 service needs one: ledger/db. A restart can't bring it back until one is installed.",
    );
  });

  it("no runtime, two need one: plural, both named", () => {
    expect(
      runtimeMissingDoctorLine({
        runtime: false,
        records: [rec("a/db", ["a-1"]), rec("b/cache", ["b-1"])],
      }),
    ).toBe(
      "No container runtime (docker) on PATH, but 2 services need one: a/db, b/cache. A restart can't bring them back until one is installed.",
    );
  });

  it("runtime present: nothing to say", () => {
    expect(
      runtimeMissingDoctorLine({
        runtime: true,
        records: [rec("ledger/db", ["ledger-db-1"])],
      }),
    ).toBeNull();
  });

  it("no runtime and no record lists containers: nothing to say", () => {
    expect(
      runtimeMissingDoctorLine({
        runtime: false,
        records: [rec("kiosk/web"), rec("kiosk/api", [])],
      }),
    ).toBeNull();
  });
});
