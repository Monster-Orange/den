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
    expect(sessionName("acme", "smb", "planner")).toBe("acme-smb:planner");
  });

  it("refuse a workspace or name outside the name rules", () => {
    expect(() => sessionName("acme", "a b", "planner")).toThrow(/workspace/);
    expect(() => sessionName("acme", "smb", "plan:ner")).toThrow(/name/);
    expect(() => sessionName("acme", "smb", "")).toThrow(/name/);
  });

  it("parse back, workspaces with dashes included", () => {
    expect(parseSessionName("acme-feat-x:planner", "acme")).toEqual({
      workspace: "feat-x",
      name: "planner",
    });
    expect(parseSessionName("other-smb:planner", "acme")).toBeNull();
    expect(parseSessionName("acme-smb", "acme")).toBeNull();
  });
});

describe("workspace isolation", () => {
  const all = [
    info("a1", "acme-smb:planner"),
    info("a2", "acme-enterprise:planner"),
    info("a3", "acme-smb-2:planner"),
  ];

  it("a session started in smb is not listed under enterprise", () => {
    const smb = all.filter((s) => inWorkspace(s, "acme", "smb"));
    const ent = all.filter((s) => inWorkspace(s, "acme", "enterprise"));
    expect(smb.map((s) => s.ref.id)).toEqual(["a1"]);
    expect(ent.map((s) => s.ref.id)).toEqual(["a2"]);
  });
});

describe("resolveSession", () => {
  const all = [
    info("a1", "acme-smb:planner", true),
    info("a2", "acme-smb:planner"),
    info("a3", "acme-enterprise:reviewer"),
    info("a4", "acme-smb:reviewer"),
  ];

  it("takes an id, a full name, <ws>:<name>, or an unambiguous bare name", () => {
    expect(resolveSession(all, "acme", "a3").ref.id).toBe("a3");
    expect(resolveSession(all, "acme", "acme-smb:reviewer").ref.id).toBe("a4");
    expect(resolveSession(all, "acme", "enterprise:reviewer").ref.id).toBe(
      "a3",
    );
    // A running session wins over an exited one of the same name.
    expect(resolveSession(all, "acme", "planner").ref.id).toBe("a2");
  });

  it("refuses an ambiguous or unknown name, naming the choices", () => {
    expect(() => resolveSession(all, "acme", "reviewer")).toThrow(
      /acme-enterprise:reviewer.*acme-smb:reviewer/,
    );
    expect(() => resolveSession(all, "acme", "nope")).toThrow(/no session/);
  });

  it("narrows a bare name to one workspace", () => {
    expect(resolveSession(all, "acme", "reviewer", "smb").ref.id).toBe("a4");
  });
});
