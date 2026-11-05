/** `brand.theme` in the org config: the distribution's default web theme. */
import { describe, expect, it, jest } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { product } from "../../../src/shared/product.js";

function brandFrom(yamlText: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "den-brand-"));
  fs.mkdirSync(path.dirname(path.join(root, product().configFile)), {
    recursive: true,
  });
  fs.writeFileSync(path.join(root, product().configFile), yamlText);
  // readBrand caches per process: load a fresh module for each case.
  let brand: { theme?: string; name: string } | undefined;
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const m = require("../../../src/shared/brand.js") as {
      readBrand: (r: string) => { theme?: string; name: string };
    };
    brand = m.readBrand(root);
  });
  fs.rmSync(root, { recursive: true, force: true });
  return brand!;
}

describe("brand.theme", () => {
  it("is read beside brand.name", () => {
    expect(brandFrom("brand:\n  name: Acme\n  theme: paper\n")).toMatchObject({
      name: "Acme",
      theme: "paper",
    });
  });
  it("is absent when unset, blank or not a string", () => {
    expect(brandFrom("brand:\n  name: Acme\n").theme).toBeUndefined();
    expect(brandFrom('brand:\n  theme: "  "\n').theme).toBeUndefined();
    expect(brandFrom("brand:\n  theme: [x]\n").theme).toBeUndefined();
  });
  it("a top-level theme: key is not read", () => {
    expect(brandFrom("theme: paper\n").theme).toBeUndefined();
  });
});
