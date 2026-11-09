/**
 * D11: the display title is the org config's brand.name ("Acme Den"), not
 * the CLI name upper-cased ("Acme-den"), when it is safe to fill into page
 * scripts and attributes; else the name upper-cased.
 */
import { describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  brandNameAt,
  nameTitle,
  titleOf,
} from "../../../src/shared/product.js";

describe("titleOf (D11)", () => {
  it("is brand.name when set and safe", () => {
    expect(titleOf("acme-den", "Acme Den")).toBe("Acme Den");
    expect(titleOf("acme-den", "Acmé Dev_2.0 - Beta")).toBe(
      "Acmé Dev_2.0 - Beta",
    );
  });

  it("is the name upper-cased without a brand.name", () => {
    expect(titleOf("acme-den")).toBe("Acme-den");
    expect(nameTitle("den")).toBe("Den");
  });

  it.each([
    `Acme "Den"`,
    "Acme's Den",
    "Acme\\Den",
    "<b>Acme</b>",
    "Acme & Co",
    "Acme`Den",
    " leading",
    "-dash",
    "x".repeat(41),
  ])("refuses %s (falls back to the name)", (brand) => {
    expect(titleOf("acme-den", brand)).toBe("Acme-den");
  });
});

describe("brandNameAt", () => {
  it("reads brand.name from the org config, trimmed", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "den-brand-"));
    try {
      fs.mkdirSync(path.join(root, "config"));
      fs.writeFileSync(
        path.join(root, "config/acme.yml"),
        "brand:\n  name: '  Acme Den '\n",
      );
      expect(brandNameAt(root, "config/acme.yml")).toBe("Acme Den");
      expect(brandNameAt(root, "config/none.yml")).toBeUndefined();
      expect(brandNameAt(null, "config/acme.yml")).toBeUndefined();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
