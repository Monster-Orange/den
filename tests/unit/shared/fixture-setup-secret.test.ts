/**
 * Issue 1018: the one-time setup value, held in memory and spent by the
 * first try that reaches it; and doctor's words for how the key was made.
 */
import { describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  SETUP_SECRET_SPENT_FILE,
  SetupSecret,
  readFixtureMadeBy,
  setupSecretRefusal,
  writeFixtureMadeBy,
} from "../../../src/shared/fixture-setup-secret.js";
import { fixtureMadeByLine } from "../../../src/ui/cli/doctor-command.js";

const V = "a-setup-value-of-some-length";

describe("SetupSecret", () => {
  it("matches once, then is used", () => {
    const s = new SetupSecret(V);
    expect(s.waiting).toBe(true);
    expect(s.take(V)).toEqual({ ok: true });
    expect(s.waiting).toBe(false);
    expect(s.take(V)).toEqual({ ok: false, code: "setup_secret_used" });
  });

  it("a wrong value is refused and spends it", () => {
    const s = new SetupSecret(V);
    expect(s.take("nope")).toEqual({ ok: false, code: "setup_secret_wrong" });
    expect(s.take(V)).toEqual({ ok: false, code: "setup_secret_used" });
  });

  it("a value of another length or type is refused, not thrown", () => {
    expect(new SetupSecret(V).take(V + "x")).toEqual({
      ok: false,
      code: "setup_secret_wrong",
    });
    expect(new SetupSecret(V).take(42)).toEqual({
      ok: false,
      code: "setup_secret_wrong",
    });
  });

  it("none at start, or dropped: no setup value", () => {
    expect(new SetupSecret(undefined).take(V)).toEqual({
      ok: false,
      code: "no_setup_secret",
    });
    expect(new SetupSecret("").take("")).toEqual({
      ok: false,
      code: "no_setup_secret",
    });
    const s = new SetupSecret(V);
    s.drop();
    expect(s.take(V)).toEqual({ ok: false, code: "no_setup_secret" });
  });

  it("never holds the value itself", () => {
    const s = new SetupSecret(V);
    expect(JSON.stringify(s)).not.toContain(V);
    expect(Object.values(s).map(String).join(" ")).not.toContain(V);
  });

  it("each refusal has its own words, none naming a value", () => {
    const words = (
      ["no_setup_secret", "setup_secret_used", "setup_secret_wrong"] as const
    ).map((c) => setupSecretRefusal(c, "den"));
    expect(new Set(words).size).toBe(3);
    for (const w of words) expect(w).not.toContain(V);
  });
});

describe("spent across a restart", () => {
  it("a value once tried stays used for the next start on the same folder; another value doesn't", () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "den-spent-"));
    expect(new SetupSecret(V, d).take("nope")).toEqual({
      ok: false,
      code: "setup_secret_wrong",
    });
    const again = new SetupSecret(V, d);
    expect(again.waiting).toBe(false);
    expect(again.take(V)).toEqual({ ok: false, code: "setup_secret_used" });
    expect(new SetupSecret("another-value", d).take("another-value")).toEqual({
      ok: true,
    });
    const file = fs.readFileSync(path.join(d, SETUP_SECRET_SPENT_FILE), "utf8");
    expect(file).not.toContain(V);
    expect(
      (
        fs.statSync(path.join(d, SETUP_SECRET_SPENT_FILE)).mode & 0o777
      ).toString(8),
    ).toBe("600");
    fs.rmSync(d, { recursive: true, force: true });
  });
});

describe("how the key was made", () => {
  it("is kept beside it and read back; anything else reads unknown", () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "den-made-by-"));
    expect(readFixtureMadeBy(d)).toBeNull();
    writeFixtureMadeBy(d, "setup-secret");
    expect(readFixtureMadeBy(d)).toBe("setup-secret");
    fs.writeFileSync(path.join(d, "fixture-person.made-by"), "by hand\n");
    expect(readFixtureMadeBy(d)).toBeNull();
    fs.rmSync(d, { recursive: true, force: true });
  });

  it("doctor's Sign-in row says it", () => {
    expect(fixtureMadeByLine(true, "setup-secret")).toMatch(
      /test person .*made from the setup secret/,
    );
    expect(fixtureMadeByLine(true, "settings")).toMatch(/Set up test person/);
    expect(fixtureMadeByLine(true, "creation")).toMatch(/at creation/);
    expect(fixtureMadeByLine(true, null)).toMatch(/test person/);
    expect(fixtureMadeByLine(false, null)).toBeNull();
  });
});
