/**
 * Issue 816 follow-up: the two test-install routes' own person check, given
 * the principal the request guard settled on. Through a real server an
 * agent's token usually stops at the guard (401: no live session holds it),
 * so the integration test can't show the route itself refusing an agent.
 * Here the agent principal reaches the route's check: it gets person_only.
 * Invented names only.
 */
import { describe, expect, it } from "@jest/globals";
import {
  fixtureGrantAccess,
  testInstallsListAccess,
} from "../../../src/ui/server/test-installs-access.js";
import type { Principal } from "../../../src/ui/server/request-guard.js";

const agent: Principal = {
  kind: "agent",
  actor: "agent:builder",
  workspace: "north",
  grants: [],
  session: { name: "builder" },
};
const person: Principal = { kind: "person", actor: "person:owner" };
const browser: Principal = { kind: "person-browser", session: "s1" };
const testPerson: Principal = {
  kind: "person",
  actor: "person:owner",
  testPerson: true,
};
const fixture: Principal = {
  kind: "person-browser",
  session: "s2",
  fixture: true,
};

describe("issue 816: GET /api/web/test-installs, the route's own check", () => {
  it("an agent principal: 403 person_only", () => {
    expect(testInstallsListAccess(agent, true)).toEqual({
      ok: false,
      status: 403,
      code: "person_only",
    });
  });
  it("an agent principal the request didn't mark: still 403 person_only", () => {
    expect(testInstallsListAccess(agent, false)).toEqual({
      ok: false,
      status: 403,
      code: "person_only",
    });
  });
  it("nobody signed in: 401 signin_required", () => {
    expect(testInstallsListAccess(undefined, false)).toEqual({
      ok: false,
      status: 401,
      code: "signin_required",
    });
  });
  it("a test person or the fixture person: 403 person_only", () => {
    for (const p of [testPerson, fixture])
      expect(testInstallsListAccess(p, false)).toMatchObject({
        ok: false,
        code: "person_only",
      });
  });
  it("the person, by bearer or browser: allowed", () => {
    expect(testInstallsListAccess(person, false)).toEqual({ ok: true });
    expect(testInstallsListAccess(browser, false)).toEqual({ ok: true });
  });
  it("a person's request carrying an agent's claim: 403 person_only", () => {
    expect(testInstallsListAccess(browser, true)).toMatchObject({
      ok: false,
      code: "person_only",
    });
  });
});

describe("issue 816: POST /api/web/fixture-person/grant, the route's own check", () => {
  it("an agent principal: person_only", () => {
    expect(fixtureGrantAccess(agent, true, false)).toEqual({
      ok: false,
      code: "person_only",
    });
    expect(fixtureGrantAccess(agent, false, false)).toEqual({
      ok: false,
      code: "person_only",
    });
  });
  it("nobody, a browser session, a test person: person_only", () => {
    for (const p of [undefined, browser, testPerson, fixture])
      expect(fixtureGrantAccess(p, false, false)).toEqual({
        ok: false,
        code: "person_only",
      });
  });
  it("the person's bearer, beyond this machine: not_this_machine", () => {
    expect(fixtureGrantAccess(person, false, true)).toEqual({
      ok: false,
      code: "not_this_machine",
    });
  });
  it("the person's bearer on this machine: allowed", () => {
    expect(fixtureGrantAccess(person, false, false)).toEqual({ ok: true });
  });
});
