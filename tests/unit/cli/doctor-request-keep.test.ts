/**
 * UK-2 (0.4.48): ui.request_memory_seconds became requests.keep_minutes.
 * Until 0.4.49 the old key still counts when the new one is unset; doctor
 * says to move it, and says nothing when it isn't there.
 */
import { describe, expect, it } from "@jest/globals";
import { requestKeepLines } from "../../../src/ui/cli/doctor-command.js";

describe("doctor: the request ledger's keep time (UK-2)", () => {
  it("says nothing when the old key isn't set", () => {
    expect(requestKeepLines("Den", () => ({}))).toEqual({
      lines: [],
      check: null,
    });
    expect(
      requestKeepLines("Den", () => ({ requests: { keep_minutes: 20 } })),
    ).toEqual({ lines: [], check: null });
  });

  it("names the old key, what it became, and whether it still counts", () => {
    const counts = requestKeepLines("Den", () => ({
      ui: { request_memory_seconds: 900 },
    }));
    expect(counts.check).toMatchObject({
      id: "request_keep",
      status: "warn",
    });
    expect(counts.check!.detail).toMatch(
      /ui\.request_memory_seconds.*requests\.keep_minutes.*15 minutes.*until 0\.4\.49/,
    );
    expect(counts.lines.join("\n")).toContain(counts.check!.detail);
    const ignored = requestKeepLines("Den", () => ({
      ui: { request_memory_seconds: 900 },
      requests: { keep_minutes: 30 },
    }));
    expect(ignored.check!.detail).toMatch(/no longer counts/);
  });
});
