/**
 * Issue 816: the person check of the two test-install routes, given the
 * principal the request guard settled on and whether the request carries an
 * agent's token or claim, the fixture person, or an agent's view
 * (`notAPerson`, notAPersonOf). Pure, so a test can hand it an agent
 * principal: through a real server an agent's token usually stops at the
 * guard first.
 */
import type { Principal } from "./request-guard.js";

export type ListAccess =
  | { ok: true }
  | {
      ok: false;
      status: 401 | 403;
      code: "signin_required" | "person_only";
    };

/**
 * `GET /api/web/test-installs`: the signed-in person, by bearer or browser,
 * and nobody else. Nobody signed in: 401, as other reads that need a sign-in
 * answer. An agent, a fixture session or a test person: 403.
 */
export function testInstallsListAccess(
  p: Principal | undefined,
  notAPerson: boolean,
): ListAccess {
  const person =
    !!p &&
    (p.kind === "person" || p.kind === "person-browser") &&
    !("testPerson" in p && p.testPerson) &&
    !("fixture" in p && p.fixture) &&
    !notAPerson;
  if (person) return { ok: true };
  return p
    ? { ok: false, status: 403, code: "person_only" }
    : { ok: false, status: 401, code: "signin_required" };
}

export type GrantAccess =
  | { ok: true }
  | { ok: false; code: "person_only" | "not_this_machine" };

/**
 * `POST /api/web/fixture-person/grant`: the person's own bearer only (never
 * a browser session, a test person or an agent), and only on this machine
 * (`beyond`: through the edge or the network).
 */
export function fixtureGrantAccess(
  p: Principal | undefined,
  notAPerson: boolean,
  beyond: boolean,
): GrantAccess {
  const person = p?.kind === "person" && !p.testPerson && !notAPerson;
  if (!person) return { ok: false, code: "person_only" };
  if (beyond) return { ok: false, code: "not_this_machine" };
  return { ok: true };
}
