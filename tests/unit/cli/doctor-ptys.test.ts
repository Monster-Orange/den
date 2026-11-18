/**
 * Issue 503: doctor's PTY row, from a stub host and a stub machine: the
 * host's open PTY masters, ✗ above sessions.pty_warn_above, ✗ when the
 * machine is near its PTY limit, nothing failed when no host runs.
 */
import { describe, expect, it } from "@jest/globals";
import { ptyLines } from "../../../src/ui/cli/doctor-ptys.js";

const settings = { warnAbove: 100, machineWarnPercent: 90 };
const roomy = () => ({ inUse: 40, max: 511 });

describe("doctor: PTYs (issue 503)", () => {
  it("✓ with the count when under the Setting and the machine has room", async () => {
    const r = await ptyLines("Den", {
      open: async () => 12,
      settings: () => settings,
      machine: roomy,
    });
    expect(r.problem).toBe(false);
    expect(r.check).toMatchObject({ id: "session_host_ptys", status: "ok" });
    expect(r.lines.join("\n")).toMatch(/✓.*12 PTY/);
    expect(r.lines.join("\n")).toMatch(/40 of 511/);
  });

  it("✗ when the host holds more than sessions.pty_warn_above", async () => {
    const r = await ptyLines("Den", {
      open: async () => 376,
      settings: () => settings,
      machine: roomy,
    });
    expect(r.problem).toBe(true);
    expect(r.check.status).toBe("fail");
    const text = r.lines.join("\n");
    expect(text).toMatch(/✗/);
    expect(text).toMatch(/376/);
    expect(text).toMatch(/sessions\.pty_warn_above/);
  });

  it("✗ when the machine is near its PTY limit, even with a small host count", async () => {
    const r = await ptyLines("Den", {
      open: async () => 3,
      settings: () => settings,
      machine: () => ({ inUse: 500, max: 511 }),
    });
    expect(r.problem).toBe(true);
    expect(r.check.status).toBe("fail");
    expect(r.lines.join("\n")).toMatch(/500 of 511/);
  });

  it("no failure when no host runs or the count can't be read", async () => {
    const none = await ptyLines("Den", {
      open: async () => null,
      settings: () => settings,
      machine: () => null,
    });
    expect(none.problem).toBe(false);
    expect(none.check.status).not.toBe("fail");
  });
});
