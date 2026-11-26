/**
 * Issue 707: doctor says where the server's warning lines are kept while
 * Den runs as a service, how large the file may grow, and the Setting.
 */
import { describe, expect, it } from "@jest/globals";
import { serverLogLines } from "../../../src/ui/cli/doctor-server-log.js";

describe("issue 707: doctor's server log row", () => {
  it("names the file, its size against the cap, and the Setting", () => {
    const r = serverLogLines("Acme", {
      path: "/st/logs/server.log",
      bytes: 3 * 1024 * 1024,
      maxMb: 20,
      cli: "acme",
    });
    expect(r.check).toEqual({
      id: "server_log",
      status: "ok",
      detail:
        "/st/logs/server.log: 3.0 MB of 20 MB, then it rotates once to server.log.1 (warnings while Acme runs as a service; acme config server_log.max_mb=20)",
    });
    expect(r.lines).toContain("  ✓  /st/logs/server.log");
  });

  it("no file yet: says so, and where it will be", () => {
    const r = serverLogLines("Acme", {
      path: "/st/logs/server.log",
      bytes: null,
      maxMb: 20,
      cli: "acme",
    });
    expect(r.check.status).toBe("ok");
    expect(r.check.detail).toMatch(
      /^\/st\/logs\/server\.log: none yet, up to 20 MB/,
    );
  });
});
