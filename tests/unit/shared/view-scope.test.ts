/**
 * The focus's pure parts (src/shared/environment-manager/scope.ts; the
 * view scope until 0.4.3, WS-6.1): which workspaces are in view, what a
 * client may store, the `--scope` flag and the line `status` prints.
 */
import { describe, expect, it } from "@jest/globals";
import {
  ownersSuffix,
  parseScope,
  scopeLine,
  scopeWorkspaceNames,
  storedScope,
  takeScopeFlag,
} from "../../../src/shared/environment-manager/scope.js";

const ws = {
  active: ["ws-b", "ws-a", "ws-c"],
  focus: "ws-a",
  known: ["ws-a", "ws-b", "ws-c", "ws-d"],
};

describe("scopeWorkspaceNames", () => {
  it("all: every active workspace, focus first, then file order", () => {
    expect(scopeWorkspaceNames("all", ws)).toEqual(["ws-a", "ws-b", "ws-c"]);
  });
  it("one active workspace: just that one", () => {
    expect(scopeWorkspaceNames("ws-c", ws)).toEqual(["ws-c"]);
  });
  it("a workspace no longer active falls back to all, never to nothing", () => {
    expect(scopeWorkspaceNames("ws-d", ws)).toEqual(["ws-a", "ws-b", "ws-c"]);
    expect(scopeWorkspaceNames("gone", ws)).toEqual(["ws-a", "ws-b", "ws-c"]);
  });
  it("skips an active name the file does not define; no focus is fine", () => {
    expect(
      scopeWorkspaceNames("all", {
        active: ["x", "ws-a"],
        focus: null,
        known: ["ws-a"],
      }),
    ).toEqual(["ws-a"]);
  });
});

describe("what may be stored", () => {
  it("parseScope: all, or a workspace on this machine", () => {
    expect(parseScope("all", ws.active)).toEqual({ ok: true, value: "all" });
    expect(parseScope("ws-c", ws.active)).toEqual({ ok: true, value: "ws-c" });
    for (const bad of ["ws-d", "", "../x", 3, null, undefined])
      expect([bad, parseScope(bad, ws.active).ok]).toEqual([bad, false]);
    expect(parseScope("ws-d", ws.active)).toEqual({
      ok: false,
      error: 'workspace "ws-d" is not on this machine',
    });
  });
  it("storedScope reads a 0.3.0 view scope: all unless a plausible name", () => {
    expect(storedScope({})).toBe("all");
    expect(storedScope({ view: { scope: "ws-b" } })).toBe("ws-b");
    expect(storedScope({ view: { scope: "../etc" } })).toBe("all");
  });
});

describe("status", () => {
  it("takes --scope out of argv; --all stays (it means verbose)", () => {
    expect(takeScopeFlag(["--scope", "ws-b", "--all"])).toEqual({
      scope: "ws-b",
      rest: ["--all"],
    });
    expect(takeScopeFlag(["--scope=all"])).toEqual({ scope: "all", rest: [] });
    expect(takeScopeFlag(["-A", "shop"])).toEqual({
      scope: null,
      rest: ["-A", "shop"],
    });
    expect(takeScopeFlag(["--scope"]).error).toMatch(/--scope needs/);
    expect(takeScopeFlag(["--scope", "--verbose"]).error).toMatch(
      /--scope needs/,
    );
  });
  it("prints the focus (WS-6.1): all workspaces, or one", () => {
    const w = (n: string) => ({ name: n, config: { services: {} } });
    expect(
      scopeLine({
        scope: "all",
        fellBack: false,
        workspaces: [w("ws-a"), w("ws-b")],
        focus: "ws-a",
      }),
    ).toBe("Focus: all workspaces (ws-a, ws-b)");
    expect(
      scopeLine({
        scope: "ws-b",
        fellBack: false,
        workspaces: [w("ws-b")],
        focus: "ws-a",
      }),
    ).toBe("Focus: ws-b");
    expect(
      scopeLine({
        scope: "ws-d",
        fellBack: true,
        workspaces: [w("ws-a")],
        focus: "ws-a",
      }),
    ).toBe("Focus: all workspaces (ws-a) (ws-d is not on this machine)");
  });
  it("names the owners of a shared service only", () => {
    expect(ownersSuffix(["ws-a", "ws-b"])).toBe(" · ws-a, ws-b");
    expect(ownersSuffix(["ws-a"])).toBe("");
    expect(ownersSuffix(undefined)).toBe("");
  });
});
