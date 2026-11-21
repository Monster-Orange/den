/** Issue 810: red-first stub; the real module follows in the next commit. */
import * as path from "path";

export const FIXTURE_PRINCIPAL = "";
export const FIXTURE_LABEL = "";

export function fixturePersonPath(stateDir: string): string {
  return path.join(stateDir, "fixture-person.key");
}

export function readFixtureSecret(stateDir: string): Buffer | null {
  void stateDir;
  return Buffer.alloc(32);
}

export function setupFixturePerson(
  stateDir: string,
  o: { testInstall: boolean; agent: boolean },
): { ok: true } | { ok: false; code: string; error: string } {
  void stateDir;
  void o;
  return { ok: false, code: "unbuilt", error: "not built" };
}

export function mintFixtureCode(
  secret: Buffer,
  now?: number,
  ttlMs?: number,
): string {
  void secret;
  void now;
  void ttlMs;
  return "unbuilt";
}

export function checkFixtureCode(
  code: string,
  secret: Buffer,
  now?: number,
): { ok: true } | { ok: false; reason: string } {
  void code;
  void secret;
  void now;
  return { ok: false, reason: "unbuilt" };
}

export function fixtureLoginLink(
  stateDir: string,
  o: { testInstall: boolean; origin: string; next?: string },
): { ok: true; url: string } | { ok: false; code: string; error: string } {
  void stateDir;
  void o;
  return { ok: false, code: "unbuilt", error: "not built" };
}

export function fixtureScopeRefusal(
  method: string,
  pathname: string,
): string | null {
  void method;
  void pathname;
  return null;
}
