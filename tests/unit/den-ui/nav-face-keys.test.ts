/**
 * Issue 95: the nav inventory's fingerprint keys each face by its font
 * family as the page's token gives it. A token may be written over several
 * lines (tokens.css wraps long values), and the same family must give the
 * same key: whitespace runs are one space, ends trimmed.
 */
import { describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import * as inventory from "../../../packages/den-ui/inventory/nav-inventory.js";

const inv = inventory as unknown as {
  navFamily: (s: string) => string;
  fingerprint: (snap: unknown) => string;
};
const REF = path.join(
  __dirname,
  "../../../packages/den-ui/inventory/reference/den-chromium-1280.json",
);

describe("the fingerprint's face keys", () => {
  it("a family written over lines is the family on one line", () => {
    expect(inv.navFamily("a,\n    b")).toBe("a, b");
    expect(
      inv.navFamily('  -apple-system,\t"Segoe UI",\n  sans-serif \n'),
    ).toBe('-apple-system, "Segoe UI", sans-serif');
  });

  it("a snapshot keyed by the wrapped token has the reference's fingerprint", () => {
    const ref = JSON.parse(fs.readFileSync(REF, "utf-8"));
    const faces: Record<string, number> = {};
    for (const [k, w] of Object.entries(
      ref.env.faces as Record<string, number>,
    ))
      faces[k.replace("Helvetica, Arial", "Helvetica,\n    Arial")] = w;
    const wrapped = { ...ref, env: { ...ref.env, faces } };
    expect(Object.keys(faces).some((k) => k.includes("\n"))).toBe(true);
    expect(inv.fingerprint(wrapped)).toBe(inv.fingerprint(ref));
  });

  it("the references' own keys are already one line each", () => {
    for (const b of ["chromium", "webkit"])
      for (const w of [1280, 390]) {
        const ref = JSON.parse(
          fs.readFileSync(REF.replace("chromium-1280", `${b}-${w}`), "utf-8"),
        );
        for (const k of Object.keys(ref.env.faces))
          expect(k).toBe(k.replace(/\s+/g, " ").trim());
      }
  });
});
