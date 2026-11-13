/**
 * Session names are `<dist>-<workspace>:<name>` (AG spec §2, MD-1), and a
 * workspace's list holds only its own sessions (the §5c gate: a session
 * started in one workspace is not listed under another).
 */
import { describe, expect, it } from "@jest/globals";
import {
  inWorkspace,
  parseSessionName,
  resolveSession,
  sessionName,
} from "../../../src/shared/sessions/names.js";
import type { SessionInfo } from "../../../src/shared/sessions/types.js";

const info = (id: string, name: string, exited = false): SessionInfo => ({
  ref: { backend: "den-pty", id },
  name,
  pid: 1,
  startedAt: "2026-11-06T00:00:00.000Z",
  ...(exited ? { exited: true, exitCode: 0 } : {}),
});

describe("session names", () => {
  it("are <dist>-<workspace>:<name>", () => {
    expect(sessionName("acme", "north", "planner")).toBe("acme-north:planner");
  });

  it("refuse a workspace or name outside the name rules", () => {
    expect(() => sessionName("acme", "a b", "planner")).toThrow(/project/);
    expect(() => sessionName("acme", "north", "plan:ner")).toThrow(/name/);
    expect(() => sessionName("acme", "north", "")).toThrow(/name/);
  });

  it("parse back, workspaces with dashes included", () => {
    expect(parseSessionName("acme-feat-x:planner", "acme")).toEqual({
      workspace: "feat-x",
      name: "planner",
    });
    expect(parseSessionName("other-north:planner", "acme")).toBeNull();
    expect(parseSessionName("acme-north", "acme")).toBeNull();
  });
});

describe("workspace isolation", () => {
  const all = [
    info("a1", "acme-north:planner"),
    info("a2", "acme-south:planner"),
    info("a3", "acme-north-2:planner"),
  ];

  it("a session started in north is not listed under south", () => {
    const north = all.filter((s) => inWorkspace(s, "acme", "north"));
    const ent = all.filter((s) => inWorkspace(s, "acme", "south"));
    expect(north.map((s) => s.ref.id)).toEqual(["a1"]);
    expect(ent.map((s) => s.ref.id)).toEqual(["a2"]);
  });
});

describe("resolveSession", () => {
  const all = [
    info("a1", "acme-north:planner", true),
    info("a2", "acme-north:planner"),
    info("a3", "acme-south:reviewer"),
    info("a4", "acme-north:reviewer"),
  ];

  it("takes an id, a full name, <ws>:<name>, or an unambiguous bare name", () => {
    expect(resolveSession(all, "acme", "a3").ref.id).toBe("a3");
    expect(resolveSession(all, "acme", "acme-north:reviewer").ref.id).toBe(
      "a4",
    );
    expect(resolveSession(all, "acme", "south:reviewer").ref.id).toBe("a3");
    // A running session wins over an exited one of the same name.
    expect(resolveSession(all, "acme", "planner").ref.id).toBe("a2");
  });

  it("refuses an ambiguous or unknown name, naming the choices", () => {
    expect(() => resolveSession(all, "acme", "reviewer")).toThrow(
      /acme-north:reviewer.*acme-south:reviewer/,
    );
    expect(() => resolveSession(all, "acme", "nope")).toThrow(/no session/);
  });

  it("narrows a bare name to one workspace", () => {
    expect(resolveSession(all, "acme", "reviewer", "north").ref.id).toBe("a4");
  });
});
