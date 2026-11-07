/**
 * WS-6.3: whether a service runs, so stopped and down differ: a failing
 * check alone is stopped; with a daemon record, or compose containers
 * found, it is down.
 */
import { describe, expect, it } from "@jest/globals";
import {
  deadAddresses,
  isDown,
  isRunning,
  recordLiveness,
  trackedAddresses,
} from "../../../src/shared/environment-manager/running.js";

describe("isRunning (WS-6.3)", () => {
  const tracked = trackedAddresses([
    { address: "notes", repoName: "notes", subsystem: "web" },
  ]);

  it("runs when its check answers up", () => {
    expect(isRunning({ repo: "a", service: "a", ok: true }, new Set())).toBe(
      true,
    );
  });

  it("a failing check with no record is stopped", () => {
    expect(
      isRunning(
        { repo: "a", service: "a", ok: false, error: "ECONNREFUSED" },
        tracked,
      ),
    ).toBe(false);
    expect(isRunning({ repo: "a", service: "a", ok: null }, tracked)).toBe(
      false,
    );
  });

  it("a failing check Den still tracks is running (down), in either spelling", () => {
    expect(
      isRunning({ repo: "notes", service: "web", ok: false }, tracked),
    ).toBe(true);
    expect(
      isRunning({ repo: "notes", service: "notes", ok: false }, tracked),
    ).toBe(true);
  });

  it("compose containers found but unhealthy run; none found is stopped", () => {
    expect(
      isRunning(
        {
          repo: "db",
          service: "db",
          ok: false,
          error: "db\texited\tExited (1)",
        },
        new Set(),
      ),
    ).toBe(true);
    expect(
      isRunning(
        { repo: "db", service: "db", ok: false, error: "not running" },
        new Set(),
      ),
    ).toBe(false);
  });
});

describe("a record whose process died (WS-6.3, 0.4.5)", () => {
  // One `ps` listing: pid 4242 leads its group (started at T); 5151 is
  // someone else.
  const T = "Fri Nov  6 10:00:00 2026";
  const ps = [
    { pid: 4242, pgid: 4242, zombie: false, lstart: T },
    { pid: 5151, pgid: 5151, zombie: false, lstart: T },
  ];
  const rec = (address: string, o: Record<string, unknown> = {}) => ({
    address,
    repoName: address,
    subsystem: address,
    ...o,
  });
  const daemons = [
    rec("notes", { pgid: 4242, pgidStartedAt: T }), // alive
    rec("blog", { pgid: 6363, pgidStartedAt: T }), // gone
    rec("wiki", { pgid: 5151, pgidStartedAt: "Thu Nov  5 09:00:00 2026" }), // pid reused
    rec("mail", { pgid: 7373, pgidStartedAt: T, containers: ["mail-db"] }), // containers outlive it
    rec("docs", { pgid: 8383, pgidStartedAt: T, handedOff: true }), // `make up` handed off
    rec("legacy"), // no group: can't tell
  ];

  it("recordLiveness: dead only when its group is verifiably gone or reused", () => {
    expect(
      Object.fromEntries(
        daemons.map((d) => [d.address, recordLiveness(d, ps)]),
      ),
    ).toEqual({
      notes: "live",
      blog: "dead",
      wiki: "dead",
      mail: "live",
      docs: "live",
      legacy: "live",
    });
    // Without a listing (ps can't run) every record is trusted.
    expect(daemons.every((d) => recordLiveness(d, null) === "live")).toBe(true);
  });

  it("a dead record doesn't run; with a failing check it is down", () => {
    const tracked = trackedAddresses(daemons, ps);
    const dead = deadAddresses(daemons, ps);
    const blog = { repo: "blog", service: "blog", ok: false };
    expect(isRunning(blog, tracked)).toBe(false);
    expect(isDown(blog, tracked, dead)).toBe(true);
    // Its check answering: it runs (and is up).
    expect(isRunning({ ...blog, ok: true }, tracked)).toBe(true);
    expect(isDown({ ...blog, ok: true }, tracked, dead)).toBe(false);
    // A live record with a failing check: runs, down. No record: stopped.
    const notes = { repo: "notes", service: "notes", ok: false };
    expect([isRunning(notes, tracked), isDown(notes, tracked, dead)]).toEqual([
      true,
      true,
    ]);
    const none = { repo: "x", service: "x", ok: false };
    expect([isRunning(none, tracked), isDown(none, tracked, dead)]).toEqual([
      false,
      false,
    ]);
  });
});
