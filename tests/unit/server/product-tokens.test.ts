/**
 * The web pages are product-neutral: every product name in them is a
 * placeholder serveFile fills from the running profile. Guards both halves:
 * no page names a product, and no page carries a placeholder serveFile
 * does not know.
 */
import { describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import {
  fillProductTokens,
  productTokens,
} from "../../../src/shared/product.js";
import { profileFrom } from "../../../src/shared/profile.js";

const PUBLIC = path.resolve("src/ui/server/public");
const pages = fs
  .readdirSync(PUBLIC)
  .filter((f) => f.endsWith(".html") || f.endsWith(".js"));

const acme = {
  ...profileFrom({ name: "acme" }),
  title: "Acme",
  manifestYml: ".acme.yml",
  manifestJson: ".acme.json",
};

describe("public pages and product placeholders", () => {
  it("has pages to check", () => expect(pages.length).toBeGreaterThan(3));

  it.each(pages)("%s uses only known placeholders", (page) => {
    const text = fs.readFileSync(path.join(PUBLIC, page), "utf-8");
    const known = new Set(Object.keys(productTokens(acme)));
    const used = text.match(/__DEN_[A-Z_]+?__(?=[^A-Z_]|_[^_]|$)/g) ?? [];
    for (const token of used) expect(known).toContain(token);
    expect(fillProductTokens(text, acme)).not.toMatch(/__DEN_/);
  });

  it("fills a page with the running product's names", () => {
    expect(
      fillProductTokens("__DEN_CLI__ up · __DEN_ENV_PREFIX___ROOT", acme),
    ).toBe("acme up · ACME_ROOT");
  });
});
