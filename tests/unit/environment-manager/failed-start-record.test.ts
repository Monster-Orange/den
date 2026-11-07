/**
 * What a detached up does with its record when the service process exits
 * (0.3.0-dev.39, and the 0.4.13 release run): a non-zero exit is a failed
 * start and keeps no record. A command that exits at once can be a zombie
 * before `ps` records its group, so "no group recorded" must not keep the
 * record either (CI: `up repox/bad` said "exited 3 during startup" and left
 * repox/bad listed, with no pgid).
 */
import { failedStartCleanup } from "../../../src/shared/environment-manager/service-runner";

const rec = { pgid: 4242, startedAt: "Sat Nov  7 22:44:48 2026" };

describe("failedStartCleanup", () => {
  it("a non-zero exit whose recorded group is gone: no record", () => {
    expect(
      failedStartCleanup(3, rec, "gone", { pgid: 4242, containers: [] }),
    ).toBe("unregister");
  });

  it("a non-zero exit before its group could be recorded: no record", () => {
    expect(failedStartCleanup(3, null, null, { containers: [] })).toBe(
      "unregister",
    );
  });

  it("containers still run: only the group goes", () => {
    expect(failedStartCleanup(3, null, null, { containers: ["db"] })).toBe(
      "clear-group",
    );
    expect(
      failedStartCleanup(3, rec, "gone", { pgid: 4242, containers: ["db"] }),
    ).toBe("clear-group");
  });

  it("keeps the record: a zero exit, a live group, another run's group, or no record", () => {
    expect(
      failedStartCleanup(0, rec, "gone", { pgid: 4242, containers: [] }),
    ).toBe("keep");
    expect(
      failedStartCleanup(3, rec, "ours", { pgid: 4242, containers: [] }),
    ).toBe("keep");
    expect(
      failedStartCleanup(3, rec, "gone", { pgid: 999, containers: [] }),
    ).toBe("keep");
    // Not recorded by this run, and the record names a group: another run's.
    expect(failedStartCleanup(3, null, null, { pgid: 999 })).toBe("keep");
    expect(failedStartCleanup(3, null, null, undefined)).toBe("keep");
  });
});
