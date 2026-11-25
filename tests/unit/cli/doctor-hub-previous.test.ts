/**
 * Issue 726: doctor's rows for state from an earlier Hub. Archived state
 * is fine (✓, with where it went); state still bound to another Hub than
 * hub.url (a change Den hasn't applied yet) warns; a token an earlier Hub
 * couldn't revoke warns, naming the Hub and why, never the token.
 */
import { describe, expect, it } from "@jest/globals";
import { previousHubLines } from "../../../src/ui/cli/doctor-hub-previous";

const OLD = "https://hub-one.example.test";
const NEW = "https://hub-two.example.test";
const bound = { url: NEW, origin: NEW, company: "two", at: "t" };

describe("issue 726: doctor, state from an earlier Hub", () => {
  it("none: one ✓ row each", () => {
    const r = previousHubLines({
      current: NEW,
      bound,
      previous: [],
      unrevoked: [],
    });
    expect(r.checks.map((c) => [c.id, c.status])).toEqual([
      ["hub:previous", "ok"],
      ["hub:unrevoked", "ok"],
      ["hub:orphan-token", "ok"],
    ]);
    expect(r.lines.join("\n")).toMatch(/no state from an earlier Hub/);
  });

  it("archived: ✓ with the Hub, when, the projects unlinked and the folder", () => {
    const r = previousHubLines({
      current: NEW,
      bound,
      previous: [
        {
          stamp: "2026-11-20T10-00-00-000Z",
          dir: "/state/hub/previous/2026-11-20T10-00-00-000Z",
          from: { url: OLD, origin: OLD, company: "one", at: "t0" },
          to: { url: NEW },
          at: "2026-11-20T10:00:00.000Z",
          projects: ["web", "api"],
        },
      ],
      unrevoked: [],
    });
    const c = r.checks.find((x) => x.id === "hub:previous")!;
    expect(c.status).toBe("ok");
    expect(c.detail).toContain(OLD);
    expect(c.detail).toMatch(/2 project links/);
    expect(c.detail).toContain("/state/hub/previous/2026-11-20T10-00-00-000Z");
  });

  it("left over: state bound to another Hub than hub.url warns, with what to do", () => {
    const r = previousHubLines({
      current: NEW,
      bound: { url: OLD, origin: OLD, at: "t" },
      previous: [],
      unrevoked: [],
    });
    const c = r.checks.find((x) => x.id === "hub:previous")!;
    expect(c.status).toBe("warn");
    expect(c.detail).toContain(OLD);
    expect(c.detail).toMatch(/restart/i);
  });

  it("a token not revoked: ⚠ naming the Hub and why, never the token", () => {
    const r = previousHubLines({
      current: NEW,
      bound,
      previous: [],
      unrevoked: [
        {
          id: "u1",
          url: OLD,
          at: "2026-11-20T10:00:00Z",
          why: "Hub didn't answer",
        },
      ],
    });
    const c = r.checks.find((x) => x.id === "hub:unrevoked")!;
    expect(c.status).toBe("warn");
    expect(c.detail).toContain(OLD);
    expect(c.detail).toMatch(/didn't answer/);
    expect(r.lines.join("\n")).toMatch(/⚠/);
  });
});
